/**
 * The supervisor boots on the node_modules it has when an install fails
 * against inputs that have not moved since the last success, and says why
 * the install failed in enough detail to tell a hang from a bad lockfile.
 *
 * The case this exists for: on 10 October fifteen installs hung to the 300s
 * timeout while the host could not reach the registry, each one logged as
 * nothing but bun's header line, and prod stayed down over a node_modules
 * that already matched bun.lock. The gate runs on an injected clock and
 * ledger; the runner is driven for real against a stand-in `bun` that hangs.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type InstallFailure,
  type InstallGateDeps,
  type InstallResult,
  type InstallSuccess,
  fileInstallLedger,
  fileInstallSuccess,
  installBeforeBoot,
  installLedgerPath,
  installSuccessPath,
  spawnBunInstall,
} from '../src/dependency-install.ts';

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What a killed hang looks like once the runner has read it. */
const hung: InstallResult = {
  ok: false,
  detail: 'ETIMEDOUT, SIGTERM, 300004ms of the 300000ms limit; bun said: bun install v1.3.10',
  error: 'ETIMEDOUT',
  signal: 'SIGTERM',
  elapsedMs: 300_004,
  timeoutMs: 300_000,
  outputPath: '/data/supervisor-install-output.log',
};

interface Setup {
  /** The inputs the last successful install left; null for none recorded. */
  lastGood?: InstallSuccess | null;
  nodeModules?: boolean;
  /** Leave the gate without a fallback, as a caller other than the supervisor. */
  noFallback?: boolean;
  fingerprint?: () => string;
  outcome: (t: number) => InstallResult;
  failure?: InstallFailure | null;
}

function gate(s: Setup) {
  const clock = { t: 0 };
  const installs: number[] = [];
  const lines: string[] = [];
  const store = { failure: s.failure ?? null, good: s.lastGood ?? null };
  const deps: InstallGateDeps = {
    install: () => {
      installs.push(clock.t);
      if (installs.length > 100) throw new Error('install ran more than 100 times');
      return s.outcome(clock.t);
    },
    fingerprint: s.fingerprint ?? (() => 'lock-a'),
    ledger: {
      load: () => store.failure,
      save: (f) => {
        store.failure = f;
      },
    },
    ledgerPath: '/data/supervisor-install-failure.json',
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    log: (l) => lines.push(l),
    ...(s.noFallback
      ? {}
      : {
          fallback: {
            lastGood: {
              load: () => store.good,
              save: (g: InstallSuccess) => {
                store.good = g;
              },
            },
            nodeModulesPresent: () => s.nodeModules ?? true,
          },
        }),
  };
  return { deps, clock, installs, lines, store };
}

const HOUR = 3_600_000;
const succeedsAfterAnHour = (t: number): InstallResult => (t >= HOUR ? { ok: true } : hung);

describe('installBeforeBoot, when an install fails over unchanged inputs', () => {
  it('boots on the existing node_modules at once, and says so loudly', async () => {
    const g = gate({ lastGood: { fingerprint: 'lock-a', at: 0 }, outcome: () => hung });
    expect(await installBeforeBoot(g.deps)).toBe('existing');
    expect(g.installs).toEqual([0]);

    expect(g.lines).toHaveLength(1);
    const line = g.lines[0] ?? '';
    expect(line).toContain('[supervisor] WARNING: bun install --frozen-lockfile FAILED');
    // The code and signal lead, then the time against the limit, then bun.
    expect(line).toContain('FAILED (ETIMEDOUT, SIGTERM, 300004ms of the 300000ms limit; bun said');
    expect(line).toContain('Full output: /data/supervisor-install-output.log');
    expect(line).toContain('Booting anyway on the existing node_modules');
    expect(line).not.toContain('\n');
  });

  it('records the whole failure in the ledger, so the next boot still backs off', async () => {
    const g = gate({ lastGood: { fingerprint: 'lock-a', at: 0 }, outcome: () => hung });
    await installBeforeBoot(g.deps);
    expect(g.store.failure).toMatchObject({
      fingerprint: 'lock-a',
      failures: 1,
      error: 'ETIMEDOUT',
      signal: 'SIGTERM',
      elapsedMs: 300_004,
      timeoutMs: 300_000,
      outputPath: '/data/supervisor-install-output.log',
    });
  });

  it('boots a relaunch inside the backoff without re-running the install', async () => {
    // What launchd does after a crash ten seconds later: a fresh gate over the
    // ledger the last one wrote. It must neither hang for another 300s nor
    // hold prod down for the backoff.
    const g = gate({
      lastGood: { fingerprint: 'lock-a', at: 0 },
      failure: { fingerprint: 'lock-a', failures: 3, lastAttemptAt: 0, detail: hung.detail ?? '' },
      outcome: () => hung,
    });
    g.clock.t = 10_000;
    expect(await installBeforeBoot(g.deps)).toBe('existing');
    expect(g.installs).toEqual([]);
    expect(g.lines[0]).toContain('WARNING: not re-running bun install until');
    expect(g.lines[0]).toContain('Booting on the existing node_modules');
  });
});

describe('installBeforeBoot keeps its refusal', () => {
  it('when bun.lock moved since the last success', async () => {
    const g = gate({ lastGood: { fingerprint: 'lock-old', at: 0 }, outcome: succeedsAfterAnHour });
    expect(await installBeforeBoot(g.deps)).toBe('installed');
    expect(g.installs.filter((t) => t < HOUR).map((t) => t / 60_000)).toEqual([0, 1, 3, 7, 15, 31]);
    expect(g.lines.some((l) => l.includes('Refusing to boot the server'))).toBe(true);
    expect(g.lines.some((l) => l.includes('Booting'))).toBe(false);
  });

  it('when no success was ever recorded', async () => {
    const g = gate({ lastGood: null, outcome: succeedsAfterAnHour });
    expect(await installBeforeBoot(g.deps)).toBe('installed');
    expect(g.installs.length).toBeGreaterThan(1);
  });

  it('when node_modules is gone', async () => {
    const g = gate({
      lastGood: { fingerprint: 'lock-a', at: 0 },
      nodeModules: false,
      outcome: succeedsAfterAnHour,
    });
    expect(await installBeforeBoot(g.deps)).toBe('installed');
    expect(g.installs.length).toBeGreaterThan(1);
  });

  it('when the caller gave no fallback', async () => {
    const g = gate({
      lastGood: { fingerprint: 'lock-a', at: 0 },
      noFallback: true,
      outcome: succeedsAfterAnHour,
    });
    expect(await installBeforeBoot(g.deps)).toBe('installed');
    expect(g.installs.length).toBeGreaterThan(1);
  });
});

describe('installBeforeBoot remembers success', () => {
  it('records the inputs every successful install brought node_modules up to', async () => {
    let lock = 'lock-a';
    const g = gate({ lastGood: null, fingerprint: () => lock, outcome: () => ({ ok: true }) });
    await installBeforeBoot(g.deps);
    expect(g.store.good).toEqual({ fingerprint: 'lock-a', at: 0 });

    lock = 'lock-b';
    g.clock.t = 5_000;
    await installBeforeBoot(g.deps);
    expect(g.store.good).toEqual({ fingerprint: 'lock-b', at: 5_000 });
  });

  it('keeps it in its own file, so deleting the failure ledger forgets nothing', () => {
    const data = tempDir('install-success-');
    const good = fileInstallSuccess(installSuccessPath(data));
    const failures = fileInstallLedger(installLedgerPath(data));
    expect(good.load()).toBeNull();

    good.save({ fingerprint: 'abc', at: 42 });
    failures.save({ fingerprint: 'abc', failures: 1, lastAttemptAt: 50, detail: 'x' });
    rmSync(installLedgerPath(data));
    expect(good.load()).toEqual({ fingerprint: 'abc', at: 42 });

    writeFileSync(installSuccessPath(data), 'not json');
    expect(good.load()).toBeNull();
  });
});

describe('spawnBunInstall on a hang', () => {
  it('names the timeout, the signal and the elapsed time, and keeps all of the output', () => {
    // A stand-in that prints what bun printed on 10 October and then waits
    // past any limit. `exec` so the kill lands on the process holding the pipes.
    const dir = tempDir('install-hang-');
    const bin = join(dir, 'bun');
    writeFileSync(
      bin,
      '#!/bin/sh\necho "bun install v1.3.10 (30e609e0)"\necho "resolving registry" >&2\nexec sleep 30\n',
    );
    chmodSync(bin, 0o755);
    const outputPath = join(dir, 'data', 'supervisor-install-output.log');
    const ticks = [1_000, 1_250];
    const r = spawnBunInstall(dir, {
      bin,
      outputPath,
      timeoutMs: 250,
      now: () => ticks.shift() ?? 0,
    })();

    expect(r.ok).toBe(false);
    expect(r.error).toBe('ETIMEDOUT');
    expect(r.signal).toBe('SIGTERM');
    expect(r.elapsedMs).toBe(250);
    expect(r.detail?.startsWith('ETIMEDOUT, SIGTERM, 250ms of the 250ms limit; bun said:')).toBe(
      true,
    );
    expect(r.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    const output = readFileSync(outputPath, 'utf8');
    expect(output).toContain('bun install v1.3.10 (30e609e0)');
    expect(output).toContain('resolving registry');
    expect(output).toContain('ETIMEDOUT, SIGTERM');
  });

  it('leads a plain failure with its exit status', () => {
    const dir = tempDir('install-exit-');
    const bin = join(dir, 'bun');
    writeFileSync(bin, '#!/bin/sh\necho "error: lockfile is frozen" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    const r = spawnBunInstall(dir, { bin, now: () => 0 })();
    expect(r.detail).toBe(
      'exit 1, no signal, 0ms of the 300000ms limit; bun said: error: lockfile is frozen',
    );
    expect(r.error).toBeUndefined();
    expect(r.outputPath).toBeUndefined();
  });
});
