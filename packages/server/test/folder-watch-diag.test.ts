/**
 * TEMPORARY diagnostic for the Linux folder-watch flake: the server cases of
 * folder-watch.test.ts, then probes of what a fresh watch hears. Never fails.
 * Removed before the PR is ready.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { MAX_WAIT_MS, SETTLE_MS, createFolderWatches, folderListing } from '../src/folder-watch.ts';
import { NUDGE_COALESCE_MS } from '../src/page-nudges.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { framesOf } from './stream-frames.ts';
import { waitFor } from './wait-for.ts';

const PAST_A_BURST = MAX_WAIT_MS + NUDGE_COALESCE_MS * 2 + 300;

function fds(): string {
  const out: string[] = [];
  try {
    const all = readdirSync('/proc/self/fd');
    for (const fd of all) {
      let target = '';
      try {
        target = readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.includes('inotify')) continue;
      let wds = 0;
      try {
        wds = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('inotify')).length;
      } catch {}
      out.push(`inotify fd ${fd} wds=${wds}`);
    }
    out.push(`open=${all.length}`);
  } catch (e) {
    out.push(`no /proc: ${(e as Error).message}`);
  }
  return out.join(' ');
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('folder watch, through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let setId = '';
  const host = { host: 'localhost' };
  const open = async (query = '') => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${setId}/events:stream${query}`, {
      headers: host,
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    return framesOf(res, abort);
  };
  const changes = (page: { names: () => string[] }) =>
    page.names().filter((n) => n === 'attachments.changed').length;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'folder-watch-data-'));
    folder = mkdtempSync(join(tmpdir(), 'folder-watch-'));
    writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
    writeFileSync(join(folder, 'guide.md'), '# Saltmarsh guide\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const bound = await handle.docStore.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    setId = bound.setId;
    // timed: past the bind's own persist and coalesced frame, so a frame
    // counted below can only come from the disk.
    await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs + NUDGE_COALESCE_MS * 2));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('a file written to disk reaches an open page as one frame', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      writeFileSync(join(folder, 'tides.md'), '# Riverbend tides\n');
      await waitFor(() => changes(page) >= 1);
      // timed: a whole burst window, to prove the one write sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      // What the page re-reads on that frame (the `/files` route's body).
      const listed = handle.docStore.listRepoFiles(setId).files ?? [];
      expect(listed.map((f) => f.relPath)).toContain('tides.md');
    } finally {
      page.stop();
    }
  });

  it('a burst of 200 writes sends a bounded handful of frames', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      for (let i = 0; i < 200; i++) writeFileSync(join(folder, `note-${i}.md`), `# ${i}\n`);
      await waitFor(() => changes(page) >= 1);
      // timed: two burst windows, long enough for any straggler pass.
      await new Promise((r) => setTimeout(r, PAST_A_BURST * 2));
      expect(changes(page)).toBeLessThanOrEqual(3);
    } finally {
      page.stop();
    }
  });

  it('holds one watch per folder and releases it with the last page', async () => {
    const agent = await open('?agentId=riverbend');
    // timed: an agent's stream alone must start nothing.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(handle.folderWatches.size()).toBe(0);
    const first = await open();
    const second = await open();
    await waitFor(() => handle.folderWatches.size() === 1);
    first.stop();
    second.stop();
    await waitFor(() => handle.folderWatches.size() === 0);
    agent.stop();
  });
});

describe('folder watch diagnostic probes', () => {
  it('a fresh watch after the server cases', async () => {
    const rows: string[] = [`start: ${fds()}`];
    for (let round = 0; round < 6; round++) {
      // The real path, exactly as folder-watch.test.ts drives it.
      const folder = mkdtempSync(join(tmpdir(), 'fw-diag-real-'));
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      let refreshes = 0;
      let passes = 0;
      let events = 0;
      const errors: string[] = [];
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
              errors.push(`${e.code} ${e.message}`);
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
      // A raw second watch on a second fresh folder, at the same moment.
      const raw = mkdtempSync(join(tmpdir(), 'fw-diag-raw-'));
      let rawEvents = 0;
      const rw = watch(raw, { recursive: true }, () => void rawEvents++);
      const t0 = Date.now();
      let at = -1;
      for (let i = 0; i < 100 && at < 0; i++) {
        writeFileSync(join(folder, 'first.md'), '# Saltmarsh\n');
        writeFileSync(join(raw, 'first.md'), '# Saltmarsh\n');
        await tick(20);
        if (refreshes > 0) at = Date.now() - t0;
      }
      rows.push(
        `round ${round}: refresh=${at}ms events=${events} passes=${passes} raw=${rawEvents} errors=[${errors.join('|')}] ${fds()}`,
      );
      if (round === 0) {
        writeFileSync(join(folder, 'README.md.tmp'), 'x');
        renameSync(join(folder, 'README.md.tmp'), join(folder, 'README.md'));
      }
      rw.close();
      watches.dispose();
      rmSync(folder, { recursive: true, force: true });
      rmSync(raw, { recursive: true, force: true });
    }
    console.log(`[fw-diag] ${rows.join('\n[fw-diag] ')}`);
    expect(true).toBe(true);
  }, 60_000);
});
