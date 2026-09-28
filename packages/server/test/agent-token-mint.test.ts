/**
 * Who may mint an agent's token: only a process running under a Claude Code
 * session launched as that agent.
 *
 * Driven against the real operating system, not a fake probe: each case
 * builds a process tree the way Claude Code does -- a session process named
 * `claude` carrying `CW_AGENT_NAME`, and a child under it that asks for the
 * token, as the MCP child does. The session is this test's own bun behind a
 * symlink named `claude`, which is all the check reads of it.
 *
 * All names are house fixtures; port 0; no production server is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core/identity';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitForFile } from './wait-for.ts';

const HARBORLIGHT = agentIdForName('Harborlight');
const RIVERBEND = agentIdForName('Riverbend');

let handle: ServerHandle;
let dataDir: string;
let binDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-token-mint-'));
  binDir = mkdtempSync(join(tmpdir(), 'agent-token-mint-bin-'));
  symlinkSync(process.execPath, join(binDir, 'claude'));
  handle = createServer({ port: 0, dataDir });
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** An environment with no agent name in it but the ones a case sets. */
function envWith(names: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CW|FEEDBACK)_(AGENT_NAME|AUTHOR)$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...names };
}

/**
 * Starts a `claude` session with `sessionEnv`, whose child -- with
 * `callerEnv` layered on top, the way `NAME=x cmd` works in a shell -- asks
 * for `agentId`'s token. Answers the status the child saw.
 */
async function mintFromSession(
  agentId: string,
  sessionEnv: Record<string, string>,
  callerEnv: Record<string, string> = {},
): Promise<number> {
  const fetcher = `const r = await fetch(${JSON.stringify(
    `http://127.0.0.1:${handle.port}/api/agents/${agentId}/token`,
  )}); console.log(r.status);`;
  const session = `const p = Bun.spawn([process.execPath, '-e', ${JSON.stringify(fetcher)}], {
    env: { ...process.env, ...${JSON.stringify(callerEnv)} }, stdout: 'pipe' });
  process.stdout.write(await new Response(p.stdout).text()); await p.exited;`;
  const proc = Bun.spawn([join(binDir, 'claude'), '-e', session], {
    env: envWith(sessionEnv),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim());
}

describe('the agent-token mint', () => {
  it("hands a session's own child that session's token", async () => {
    // The positive control, and the MCP child's first mint on every spawn.
    expect(await mintFromSession(HARBORLIGHT, { CW_AGENT_NAME: 'Harborlight' })).toBe(200);
  }, 20_000);

  it("refuses a session's child another agent's token", async () => {
    expect(await mintFromSession(RIVERBEND, { CW_AGENT_NAME: 'Harborlight' })).toBe(403);
  }, 20_000);

  it("is not fooled by a caller that renames itself under another agent's session", async () => {
    // `CW_AGENT_NAME=Harborlight curl …` from Riverbend's shell: the
    // caller's own environment changes, the session above it does not.
    expect(
      await mintFromSession(
        HARBORLIGHT,
        { CW_AGENT_NAME: 'Riverbend' },
        { CW_AGENT_NAME: 'Harborlight' },
      ),
    ).toBe(403);
  }, 20_000);

  it('reads the caller itself when its session names no agent', async () => {
    // A name set in MCP-server config rather than the launch environment.
    expect(await mintFromSession(HARBORLIGHT, {}, { CW_AGENT_NAME: 'Harborlight' })).toBe(200);
  }, 20_000);

  it('refuses a process that detached from every session', async () => {
    // Named Harborlight in its own environment, but its parent shell exits
    // and it is reparented to launchd / init: no session is above it, which
    // is the shape a deliberate impersonation takes.
    const out = join(binDir, 'detached.out');
    const fetcher = `const r = await fetch(${JSON.stringify(
      `http://127.0.0.1:${handle.port}/api/agents/${HARBORLIGHT}/token`,
    )}); await Bun.write(${JSON.stringify(`${out}.tmp`)}, String(r.status));
    require('node:fs').renameSync(${JSON.stringify(`${out}.tmp`)}, ${JSON.stringify(out)});`;
    const shell = Bun.spawn(
      ['sh', '-c', `(sleep 0.3; exec "$0" -e "$1") >/dev/null 2>&1 &`, process.execPath, fetcher],
      { env: envWith({ CW_AGENT_NAME: 'Harborlight' }) },
    );
    await shell.exited;
    expect(await waitForFile(out, (t) => t.length > 0, { timeout: 4_000 })).toBe('403');
  }, 20_000);

  it('refuses the server calling itself over loopback', async () => {
    // Its hosted sessions mint in-process instead (connector/session-factory.ts).
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agents/${HARBORLIGHT}/token`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('agent-token-not-yours');
  });
});
