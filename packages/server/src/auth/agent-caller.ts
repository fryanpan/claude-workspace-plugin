/**
 * Which agent the process on the other end of a loopback socket belongs to.
 *
 * The agent-token mint (`GET /api/agents/<id>/token`) used to hand a token for
 * ANY agent id to any local non-browser process. An agent id is a hash of a
 * name written on the board, so one session could mint another's token and
 * read that agent's whole feed. This module is the check the mint now runs:
 * it finds the process that opened the socket and asks the operating system
 * which agent that process was launched as.
 *
 * ## What decides
 *
 * An agent's name is set in the environment its Claude Code session was
 * launched with (`CW_AGENT_NAME`, read by `resolveAgentAuthor`), and the MCP
 * child inherits it. So the caller's agent is read from the **nearest
 * ancestor process named `claude`** — the session — not from the caller
 * itself. A process's own environment is whatever its parent chose to give
 * it: `CW_AGENT_NAME=<someone else> curl …` run from one session's shell
 * changes the curl's environment and nothing above it.
 *
 * One fallback, to the calling process's own environment, when the session
 * names no agent — its name came from MCP-server config rather than from the
 * launch environment, or the session is the desktop app, whose process names
 * start with `Claude`. It applies only to the session's DIRECT child, which
 * is what an MCP server is. A command the session runs goes through a shell,
 * so it is a grandchild at least, and an unnamed session's
 * `CW_AGENT_NAME=<someone> curl …` is refused rather than believed.
 *
 * A caller with no `claude` ancestor at all is refused. The MCP child always
 * has one; a process that detached from its session (reparented to launchd or
 * init) has none, and that is the shape a deliberate impersonation takes.
 *
 * ## What it does not stop
 *
 * Every session on this machine runs as one OS user, so a process that wants
 * agent X's token badly enough can read the server's key file and compute it,
 * or launch a new Claude Code session under X's name, or — from a session
 * launched with no name — `exec` itself in place of the session's shell so it
 * becomes the session's direct child. No check on a route can
 * stop either. What this stops is one session, or anything it runs, asking
 * the server for a different agent's token.
 *
 * ## How it looks
 *
 * `lsof` names the process holding the client end of the socket; `ps` gives
 * the process table and, on macOS, the environment; Linux reads
 * `/proc/<pid>/environ`. Measured at ~25ms on the host, once per MCP child
 * (the client caches its token for the session).
 *
 * Both are spawned by absolute path, never looked up on PATH: prod's launchd
 * job has no `/usr/sbin` on its PATH, and macOS keeps `lsof` only there, so a
 * bare `lsof` failed to spawn and every mint was refused.
 *
 * A command that fails is run once more after `PROBE_RETRY_DELAY_MS`. Prod
 * refused two mints in one day with "lsof could not run" while every other
 * mint succeeded, and under `CW_REQUIRE_AGENT_TOKEN=1` such a refusal cuts a
 * real agent off its stream. A refusal names how each attempt failed — the
 * exit code, or that the spawn threw — and never the command's output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveAgentAuthor } from '../../../mcp/src/author.ts';
import { SHARED_AGENT_IDS } from '../agent-watches.ts';

/** The socket peer, as `server.requestIP` reports it. */
export interface PeerSocket {
  address: string;
  port: number;
}

/** Who the caller is, or why that could not be established. */
export type CallerAgent =
  | { ok: true; agentId: string | null; via: 'session' | 'process' }
  | { ok: false; reason: string };

/** A command's stdout, or how it failed: `exited 2`, `spawn threw EAGAIN`,
 *  `not installed`. The failure never carries output. */
export type ProbeResult = { ok: true; out: string } | { ok: false; cause: string };

/** The operating-system reads, injectable so the parsing is testable. */
export interface ProcessProbe {
  /** Runs a command. */
  run(argv: string[]): Promise<ProbeResult>;
  /** Reads a file; null when it cannot be read. */
  readFile(path: string): string | null;
  platform: NodeJS.Platform;
  selfPid: number;
}

/** Where each binary the probe runs may live, in the order they are tried. */
const PROBE_BINARIES: Record<string, Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  lsof: { darwin: ['/usr/sbin/lsof'], linux: ['/usr/bin/lsof', '/usr/sbin/lsof'] },
  ps: { darwin: ['/bin/ps'], linux: ['/bin/ps', '/usr/bin/ps'] },
};

/** The absolute path `name` runs from on `platform`, or null when it is not
 *  installed where the system puts it. PATH is never consulted. */
export function resolveProbeBinary(
  name: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return PROBE_BINARIES[name]?.[platform]?.find(exists) ?? null;
}

export const systemProbe: ProcessProbe = {
  async run(argv) {
    const [name = '', ...args] = argv;
    const bin = resolveProbeBinary(name, process.platform);
    if (bin === null) return { ok: false, cause: 'not installed' };
    try {
      const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'ignore' });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // lsof exits 1 when it matched nothing, which is an answer, not a failure.
      if (code === 0 || (code === 1 && name === 'lsof')) return { ok: true, out };
      return { ok: false, cause: `exited ${code}` };
    } catch (err) {
      // Only an errno-style code, never the message, which can quote paths.
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        cause:
          typeof code === 'string' && /^E[A-Z]+$/.test(code)
            ? `spawn threw ${code}`
            : 'spawn threw',
      };
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  platform: process.platform,
  selfPid: process.pid,
};

/**
 * The pid holding the client end of `peerPort -> serverPort`, from
 * `lsof -Fpn` output. Both ends of a loopback connection are listed; the
 * client's is the one whose LOCAL port is the peer port.
 */
export function parseLsofPeer(output: string, peerPort: number, serverPort: number): number | null {
  let pid: number | null = null;
  const end = new RegExp(`:${peerPort}->.*:${serverPort}$`);
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && end.test(line) && pid !== null && Number.isInteger(pid)) {
      return pid;
    }
  }
  return null;
}

/** `ps -Ao pid=,ppid=,comm=` into pid -> { ppid, name }. */
export function parseProcessTable(output: string): Map<number, { ppid: number; name: string }> {
  const table = new Map<number, { ppid: number; name: string }>();
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const comm = m[3] ?? '';
    table.set(Number(m[1]), { ppid: Number(m[2]), name: comm.slice(comm.lastIndexOf('/') + 1) });
  }
  return table;
}

/**
 * The environment from macOS `ps -wwE` output, given the same process's
 * `ps -ww` output (its arguments alone). The environment is what follows the
 * arguments, so stripping them first keeps an argument that merely mentions
 * `CW_AGENT_NAME=` from being read as the variable.
 */
export function parsePsEnv(argsOnly: string, withEnv: string): Record<string, string> {
  const args = argsOnly.replace(/\n$/, '');
  const full = withEnv.replace(/\n$/, '');
  const tail = full.startsWith(args) ? full.slice(args.length) : '';
  const env: Record<string, string> = {};
  for (const pair of tail.trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** `/proc/<pid>/environ`: NUL-separated `KEY=value`. */
export function parseProcEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of raw.split('\0')) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** How long a failed probe command waits before its one retry. */
export const PROBE_RETRY_DELAY_MS = 100;

/** Runs a probe command, and once more after `delayMs` if it fails. A double
 *  failure's cause names both attempts: `exited 2, then exited 2`. */
async function runWithRetry(
  probe: ProcessProbe,
  argv: string[],
  delayMs: number,
): Promise<ProbeResult> {
  const first = await probe.run(argv);
  if (first.ok) return first;
  await Bun.sleep(delayMs);
  const second = await probe.run(argv);
  return second.ok ? second : { ok: false, cause: `${first.cause}, then ${second.cause}` };
}

async function envOf(
  pid: number,
  probe: ProcessProbe,
  delayMs: number,
): Promise<{ env: Record<string, string> } | { cause: string }> {
  if (probe.platform === 'linux') {
    const raw = probe.readFile(`/proc/${pid}/environ`);
    return raw === null ? { cause: 'environ unreadable' } : { env: parseProcEnviron(raw) };
  }
  const args = await runWithRetry(
    probe,
    ['ps', '-ww', '-o', 'command=', '-p', String(pid)],
    delayMs,
  );
  if (!args.ok) return { cause: `ps ${args.cause}` };
  const full = await runWithRetry(
    probe,
    ['ps', '-wwE', '-o', 'command=', '-p', String(pid)],
    delayMs,
  );
  if (!full.ok) return { cause: `ps ${full.cause}` };
  return { env: parsePsEnv(args.out, full.out) };
}

/** The agent an environment names, or null for none (the shared identity). */
export function agentIdOfEnv(env: Record<string, string>): string | null {
  const id = resolveAgentAuthor(env).id;
  return SHARED_AGENT_IDS.has(id) ? null : id;
}

/** The session a process runs under: its nearest ancestor named `claude`
 *  (any case). */
function nearestSession(
  pid: number,
  table: Map<number, { ppid: number; name: string }>,
): number | null {
  const seen = new Set<number>();
  let cur = table.get(pid)?.ppid;
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const row = table.get(cur);
    if (!row) return null;
    // `claude` is the CLI; `Claude`, `Claude Helper` and the like are the
    // desktop app, which hosts MCP servers the same way.
    if (/^claude/i.test(row.name)) return cur;
    cur = row.ppid;
  }
  return null;
}

/** Which agent opened this socket. `agentId: null` is "no named agent". */
export async function identifyCallerAgent(
  peer: PeerSocket,
  serverPort: number,
  probe: ProcessProbe = systemProbe,
  retryDelayMs: number = PROBE_RETRY_DELAY_MS,
): Promise<CallerAgent> {
  const lsof = await runWithRetry(
    probe,
    ['lsof', '-nP', `-iTCP:${peer.port}`, '-sTCP:ESTABLISHED', '-Fpn'],
    retryDelayMs,
  );
  if (!lsof.ok) return { ok: false, reason: `lsof could not run (${lsof.cause})` };
  const pid = parseLsofPeer(lsof.out, peer.port, serverPort);
  if (pid === null) return { ok: false, reason: 'no process holds the client end of this socket' };
  if (pid === probe.selfPid) {
    // The server calling itself. Its hosted sessions mint in-process
    // (connector/session-factory.ts), so a loopback mint from here is nobody.
    return { ok: false, reason: 'the server process does not mint over loopback' };
  }
  const ps = await runWithRetry(probe, ['ps', '-Ao', 'pid=,ppid=,comm='], retryDelayMs);
  if (!ps.ok) return { ok: false, reason: `ps could not run (${ps.cause})` };
  const table = parseProcessTable(ps.out);
  const session = nearestSession(pid, table);
  if (session === null)
    return { ok: false, reason: 'the caller runs under no Claude Code session' };
  const sessionEnv = await envOf(session, probe, retryDelayMs);
  if (!('env' in sessionEnv)) {
    return { ok: false, reason: `the session's environment is unreadable (${sessionEnv.cause})` };
  }
  const named = agentIdOfEnv(sessionEnv.env);
  if (named !== null) return { ok: true, agentId: named, via: 'session' };
  if (table.get(pid)?.ppid !== session) {
    return {
      ok: false,
      reason: 'the session names no agent and the caller is not its direct child',
    };
  }
  const ownEnv = await envOf(pid, probe, retryDelayMs);
  if (!('env' in ownEnv)) {
    return { ok: false, reason: `the caller's environment is unreadable (${ownEnv.cause})` };
  }
  return { ok: true, agentId: agentIdOfEnv(ownEnv.env), via: 'process' };
}
