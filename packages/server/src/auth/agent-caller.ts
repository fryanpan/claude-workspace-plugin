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
 * One fallback, to the calling process's own environment,
 * when the session names no agent — its name came from MCP-server config
 * rather than from the launch environment, or the session is the desktop
 * app, whose process names start with `Claude`.
 *
 * A caller with no `claude` ancestor at all is refused. The MCP child always
 * has one; a process that detached from its session (reparented to launchd or
 * init) has none, and that is the shape a deliberate impersonation takes.
 *
 * ## What it does not stop
 *
 * Every session on this machine runs as one OS user, so a process that wants
 * agent X's token badly enough can read the server's key file and compute it,
 * or launch a new Claude Code session under X's name. No check on a route can
 * stop either. What this stops is one session, or anything it runs, asking
 * the server for a different agent's token.
 *
 * ## How it looks
 *
 * `lsof` names the process holding the client end of the socket; `ps` gives
 * the process table and, on macOS, the environment; Linux reads
 * `/proc/<pid>/environ`. Measured at ~25ms on the host, once per MCP child
 * (the client caches its token for the session).
 */
import { readFileSync } from 'node:fs';
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

/** The operating-system reads, injectable so the parsing is testable. */
export interface ProcessProbe {
  /** Runs a command; its stdout, or null if it could not run or failed. */
  run(argv: string[]): Promise<string | null>;
  /** Reads a file; null when it cannot be read. */
  readFile(path: string): string | null;
  platform: NodeJS.Platform;
  selfPid: number;
}

export const systemProbe: ProcessProbe = {
  async run(argv) {
    try {
      const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // lsof exits 1 when it matched nothing, which is an answer, not a failure.
      return code === 0 || (code === 1 && argv[0] === 'lsof') ? out : null;
    } catch {
      return null;
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

async function envOf(pid: number, probe: ProcessProbe): Promise<Record<string, string> | null> {
  if (probe.platform === 'linux') {
    const raw = probe.readFile(`/proc/${pid}/environ`);
    return raw === null ? null : parseProcEnviron(raw);
  }
  const args = await probe.run(['ps', '-ww', '-o', 'command=', '-p', String(pid)]);
  const full = await probe.run(['ps', '-wwE', '-o', 'command=', '-p', String(pid)]);
  return args === null || full === null ? null : parsePsEnv(args, full);
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
): Promise<CallerAgent> {
  const lsof = await probe.run(['lsof', '-nP', `-iTCP:${peer.port}`, '-sTCP:ESTABLISHED', '-Fpn']);
  if (lsof === null) return { ok: false, reason: 'lsof could not run' };
  const pid = parseLsofPeer(lsof, peer.port, serverPort);
  if (pid === null) return { ok: false, reason: 'no process holds the client end of this socket' };
  if (pid === probe.selfPid) {
    // The server calling itself. Its hosted sessions mint in-process
    // (connector/session-factory.ts), so a loopback mint from here is nobody.
    return { ok: false, reason: 'the server process does not mint over loopback' };
  }
  const ps = await probe.run(['ps', '-Ao', 'pid=,ppid=,comm=']);
  if (ps === null) return { ok: false, reason: 'ps could not run' };
  const session = nearestSession(pid, parseProcessTable(ps));
  if (session === null)
    return { ok: false, reason: 'the caller runs under no Claude Code session' };
  const sessionEnv = await envOf(session, probe);
  if (sessionEnv === null) return { ok: false, reason: "the session's environment is unreadable" };
  const named = agentIdOfEnv(sessionEnv);
  if (named !== null) return { ok: true, agentId: named, via: 'session' };
  const ownEnv = await envOf(pid, probe);
  if (ownEnv === null) return { ok: false, reason: "the caller's environment is unreadable" };
  return { ok: true, agentId: agentIdOfEnv(ownEnv), via: 'process' };
}
