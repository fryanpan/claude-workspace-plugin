/**
 * How the supervisor stops its children before it exits: SIGTERM, wait,
 * SIGKILL, wait — and then say whether that worked.
 *
 * Moved out of `scripts/serve.ts` so it can be driven in a test. The steps
 * are unchanged. What is new is the last line: on 10 October a restart at
 * 08:21Z logged `restarting via launchd`, and the wedged server it was meant
 * to replace was still up hours later at 0% CPU, its port still accepting
 * connections. This code sends SIGKILL to the pid it spawned, and a Bun
 * server whose main thread is blocked dies on it (`supervisor-reap.test.ts`
 * proves both). A pid that outlives SIGKILL is one the kernel has not let
 * exit — on macOS, typically a thread in an uninterruptible wait such as an
 * open of a cloud file still being fetched. Nothing in userspace can end
 * that. The supervisor used to exit without a word in that case, so the log
 * could not say whether the kill had even been tried. Now it names the pid
 * and its `ps` state.
 */
import { spawnSync } from 'node:child_process';

/** The part of a `ChildProcess` this reads. */
export interface Reapable {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}

export interface ReapDeps {
  children: () => Reapable[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** How long a child gets to honour SIGTERM before we stop being polite. */
  termGraceMs: number;
  killGraceMs: number;
  /** `ps`'s state column for a pid, or null when it cannot say. */
  processState?: (pid: number) => string | null;
}

/**
 * SIGTERM every child, then WAIT for them to actually die, then SIGKILL
 * whatever is left. Resolves with the pids still running after that.
 *
 * The predecessor of this function fired SIGTERM and called `process.exit`
 * 300ms later without ever looking at whether anything died. A server child
 * midway through hydrating 5,622 documents does not exit in 300ms, so it was
 * reparented to launchd and kept running — holding its port, its 2,553 file
 * watchers and its memory — while launchd started a replacement. On
 * 2026-08-29 that leak ran nine times; the last survivor reached 2.77 GB and
 * was the process jetsam killed when the machine ran out of memory and, with
 * it, network buffers. `activity-writer.lock is held by pid 88883` appears in
 * the log across seven consecutive restarts: one orphan, outliving them all.
 */
export async function reapChildren(deps: ReapDeps): Promise<number[]> {
  const running = () => deps.children().filter((p) => p.exitCode === null && p.signalCode === null);
  for (const p of running()) {
    try {
      p.kill('SIGTERM');
    } catch {}
  }
  const softDeadline = deps.now() + deps.termGraceMs;
  while (deps.now() < softDeadline && running().length > 0) await deps.sleep(100);

  const stubborn = running();
  if (stubborn.length === 0) return [];
  deps.log(
    `[supervisor] ${stubborn.length} child(ren) ignored SIGTERM after ` +
      `${deps.termGraceMs / 1000}s — SIGKILL (pids ${stubborn.map((p) => p.pid).join(', ')})`,
  );
  for (const p of stubborn) {
    try {
      p.kill('SIGKILL');
    } catch {}
  }
  const hardDeadline = deps.now() + deps.killGraceMs;
  while (deps.now() < hardDeadline && running().length > 0) await deps.sleep(50);

  const survivors = running().flatMap((p) => (p.pid === undefined ? [] : [p.pid]));
  if (survivors.length === 0) return [];
  const state = deps.processState ?? psState;
  const named = survivors.map((pid) => `${pid} (ps state ${state(pid) ?? 'unknown'})`);
  deps.log(
    `[supervisor] pid ${named.join(', ')} still running ${deps.killGraceMs / 1000}s after ` +
      'SIGKILL — the kernel has not let it exit, so it keeps its port and the next ' +
      'supervisor will wait for that port. Exiting anyway; only the stuck call returning, or ' +
      'a reboot, ends it.',
  );
  return survivors;
}

/** `ps -o stat=`: `U` is an uninterruptible wait on macOS, `D` on Linux. */
function psState(pid: number): string | null {
  try {
    const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const out = (r.stdout ?? '').trim();
    return out || null;
  } catch {
    return null;
  }
}
