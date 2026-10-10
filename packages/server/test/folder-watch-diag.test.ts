/**
 * TEMPORARY diagnostic for the Linux folder-watch flake. Never fails; prints
 * what a fresh recursive watch heard. Removed before the PR is ready.
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderWatches, folderListing } from '../src/folder-watch.ts';

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  }
};

function inotifyState(): string {
  const out: string[] = [];
  try {
    for (const fd of readdirSync('/proc/self/fd')) {
      let target = '';
      try {
        target = readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.includes('inotify')) continue;
      const info = read(`/proc/self/fdinfo/${fd}`);
      out.push(`fd ${fd}: ${info.split('\n').filter((l) => l.startsWith('inotify')).length} wds`);
    }
    out.push(`open fds: ${readdirSync('/proc/self/fd').length}`);
  } catch (e) {
    out.push(`no /proc: ${(e as Error).message}`);
  }
  return out.join('; ');
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('folder watch diagnostic (temporary)', () => {
  it('reports what fresh recursive watches hear', async () => {
    console.log(
      `[fw-diag] max_user_watches=${read('/proc/sys/fs/inotify/max_user_watches')} max_user_instances=${read('/proc/sys/fs/inotify/max_user_instances')} ${inotifyState()}`,
    );
    const rows: string[] = [];
    for (let round = 0; round < 25; round++) {
      const folder = mkdtempSync(join(tmpdir(), 'fw-diag-'));
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      const errors: string[] = [];
      const events: string[] = [];
      let thrown = '';
      let w: ReturnType<typeof watch> | null = null;
      try {
        w = watch(folder, { recursive: true }, (type, name) => events.push(`${type}:${name}`));
        w.on('error', (e: NodeJS.ErrnoException) =>
          errors.push(`${e.code ?? ''} ${e.errno ?? ''} ${e.syscall ?? ''} ${e.message}`),
        );
      } catch (e) {
        thrown = (e as Error).message;
      }
      const t0 = Date.now();
      let firstAt = -1;
      for (let i = 0; i < 100 && firstAt < 0; i++) {
        writeFileSync(join(folder, 'first.md'), '# Saltmarsh\n');
        await tick(20);
        if (events.length > 0) firstAt = Date.now() - t0;
      }
      rows.push(
        `round ${round}: first=${firstAt}ms events=${events.length} errors=[${errors.join(' | ')}] thrown=${thrown}`,
      );
      w?.close();
      rmSync(folder, { recursive: true, force: true });
    }
    console.log(`[fw-diag] ${rows.join('\n[fw-diag] ')}`);
    console.log(`[fw-diag] after: ${inotifyState()}`);
    expect(true).toBe(true);
  }, 120_000);

  it('reports what the real watch path hears', async () => {
    const rows: string[] = [];
    for (let round = 0; round < 25; round++) {
      const folder = mkdtempSync(join(tmpdir(), 'fw-diag-real-'));
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      let refreshes = 0;
      let passes = 0;
      let events = 0;
      const watches = createFolderWatches(
        { sourceOf: () => ({ root: folder }), refresh: async () => void refreshes++ },
        {
          settleMs: 20,
          maxWaitMs: 100,
          watch: (root, onEvent) => {
            const w = watch(root, { recursive: true }, (_t, name) => {
              events++;
              onEvent(typeof name === 'string' ? name : null);
            });
            w.on('error', (e: NodeJS.ErrnoException) => {
              rows.push(`round ${round}: ERROR ${e.code} ${e.message}`);
              w.close();
            });
            return w;
          },
          listPaths: ({ root }) => {
            passes++;
            return folderListing(root);
          },
        },
      );
      watches.sync('set-1', 1);
      const t0 = Date.now();
      let at = -1;
      for (let i = 0; i < 150 && at < 0; i++) {
        writeFileSync(join(folder, 'first.md'), '# Saltmarsh\n');
        await tick(20);
        if (refreshes > 0) at = Date.now() - t0;
      }
      rows.push(`round ${round}: refresh=${at}ms events=${events} passes=${passes}`);
      watches.dispose();
      rmSync(folder, { recursive: true, force: true });
    }
    console.log(`[fw-diag-real] ${rows.join('\n[fw-diag-real] ')}`);
    console.log(`[fw-diag-real] after: ${inotifyState()}`);
    expect(true).toBe(true);
  }, 120_000);
});
