/**
 * What the supervisor's restart does to the server it is replacing.
 *
 * On 10 October a restart logged `restarting via launchd` and the wedged
 * server it targeted stayed up. The first case is the positive control: a
 * real Bun server whose main thread is blocked and which catches SIGTERM —
 * so SIGTERM alone cannot end it — dies when the reap sends SIGKILL. The
 * second is the case the reap cannot fix, a pid that outlives SIGKILL, and
 * asserts that it is now named in the log rather than passed over in silence.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Reapable, reapChildren } from '../src/supervisor-reap.ts';
import { waitFor } from './wait-for.ts';

const scratch: string[] = [];
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const p of spawned.splice(0))
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const realDeps = {
  now: Date.now,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  termGraceMs: 300,
  killGraceMs: 2_000,
};

describe('reapChildren', () => {
  it('ends a server whose loop is blocked and which ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-reap-'));
    scratch.push(dir);
    const script = join(dir, 'wedged.ts');
    writeFileSync(
      script,
      [
        "process.on('SIGTERM', () => console.log('term handler ran'));",
        "Bun.serve({ port: 0, fetch: () => new Response('ok') });",
        "console.log('ready');",
        'const end = Date.now() + 60_000;',
        'while (Date.now() < end) {}',
      ].join('\n'),
    );
    const child = spawn('bun', ['run', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    spawned.push(child);
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    await waitFor(() => out.includes('ready'), { timeout: 20_000, describe: 'the child to serve' });

    const lines: string[] = [];
    const survivors = await reapChildren({
      ...realDeps,
      children: () => [child],
      log: (l) => lines.push(l),
    });

    expect(survivors).toEqual([]);
    expect(child.signalCode).toBe('SIGKILL');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ignored SIGTERM');
    expect(out).not.toContain('term handler ran');
  }, 30_000);

  it('names a pid that outlives SIGKILL, with its process state', async () => {
    const signals: string[] = [];
    const stuck: Reapable = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: (sig) => {
        signals.push(sig);
        return true;
      },
    };
    const clock = { t: 0 };
    const lines: string[] = [];
    const survivors = await reapChildren({
      children: () => [stuck],
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (l) => lines.push(l),
      termGraceMs: 5_000,
      killGraceMs: 2_000,
      processState: (pid) => (pid === 4242 ? 'U' : null),
    });

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(survivors).toEqual([4242]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('pid 4242 (ps state U) still running 2s after SIGKILL');
    expect(lines[1]).toContain('keeps its port');
  });

  it('says nothing when every child honours SIGTERM', async () => {
    const child: Reapable = {
      pid: 7,
      exitCode: null,
      signalCode: null,
      kill: () => {
        child.signalCode = 'SIGTERM';
        return true;
      },
    };
    const lines: string[] = [];
    const survivors = await reapChildren({
      ...realDeps,
      children: () => [child],
      log: (l) => lines.push(l),
    });
    expect(survivors).toEqual([]);
    expect(lines).toEqual([]);
  });
});
