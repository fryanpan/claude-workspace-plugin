/**
 * An open folder review hears a file written straight to disk
 * (`folder-watch.ts`), and the watch lives exactly as long as a page holds
 * the review's stream.
 *
 * The server cases bind a real temp folder, open the stream the page holds,
 * and then write with `writeFileSync` the way an agent's Write or a git
 * checkout would — no re-bind, no refresh call. The unit cases drive the
 * decision with an injected watch so "a save is not news" is asserted
 * without racing a filesystem.
 *
 * All fixtures are invented. Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentIdOf } from '@claude-workspaces/core';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import {
  MAX_WAIT_MS,
  SETTLE_MS,
  type WatchFn,
  createFolderWatches,
  folderListing,
  isWatchedPath,
} from '../src/folder-watch.ts';
import { NUDGE_COALESCE_MS } from '../src/page-nudges.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

/** Every event name read off an open stream, until stopped. */
function framesOf(
  res: Response,
  abort: AbortController,
): { names: () => string[]; stop: () => void } {
  const names: string[] = [];
  let buf = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const name = /^event: (.+)$/m.exec(buf.slice(0, sep))?.[1];
          if (name) names.push(name);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  // Abort, not just cancel the reader: the server learns a page left only
  // when its connection closes.
  return { names: () => names, stop: () => abort.abort() };
}

/** Past one burst's whole journey: settle, the pass, the coalesced frame. */
const PAST_A_BURST = MAX_WAIT_MS + NUDGE_COALESCE_MS * 2 + 300;

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

describe('diff watch, through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let reviewId = '';
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Harborlight',
        GIT_AUTHOR_EMAIL: 'harborlight@example.invalid',
        GIT_COMMITTER_NAME: 'Harborlight',
        GIT_COMMITTER_EMAIL: 'harborlight@example.invalid',
      },
    }).trim();
  const open = async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${reviewId}/events:stream`, {
      headers: { host: 'localhost' },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    return framesOf(res, abort);
  };
  const changes = (page: { names: () => string[] }) =>
    page.names().filter((n) => n === 'attachments.changed').length;
  /** The diff file list's row for a path, as the sidebar reads it. */
  const row = (relPath: string) =>
    handle.docStore
      .list()
      .find((m) => attachmentIdOf(m) === reviewId && m.type === 'diff' && m.relPath === relPath);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'diff-watch-data-'));
    repo = mkdtempSync(join(tmpdir(), 'diff-watch-repo-'));
    git('init', '-q');
    writeFileSync(join(repo, 'tides.md'), '# Riverbend tides\n');
    writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // One change already, so the review has something to list.
    writeFileSync(join(repo, 'tides.md'), '# Riverbend tides\n\nHigh water at noon.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const bound = await handle.docStore.bindDiff({ repoPath: repo, base: 'HEAD' });
    if (!bound.ok) throw new Error(`bind failed: ${bound.error}`);
    reviewId = bound.reviewId;
    // timed: past the bind's own persist and coalesced frame, so a frame
    // counted below can only come from the disk.
    await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs + NUDGE_COALESCE_MS * 2));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('a tracked file’s first edit joins the list, a save moves its counts, a no-op save is silent', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      expect(row('guide.md')).toBeUndefined();
      // A first edit to a tracked file: the git listing does not move.
      writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n\nOne.\n');
      await waitFor(() => changes(page) >= 1);
      // timed: a whole burst window, to prove the edit sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      expect(row('guide.md')?.diffAdditions).toBe(2);

      writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n\nOne.\nTwo.\n');
      await waitFor(() => changes(page) >= 2);
      // timed: a whole burst window, to prove the save sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(2);
      expect(row('guide.md')?.diffAdditions).toBe(3);

      // The same bytes again: an event, and nothing for the page.
      writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n\nOne.\nTwo.\n');
      // timed: two burst windows, long enough for the pass to have run.
      await new Promise((r) => setTimeout(r, PAST_A_BURST * 2));
      expect(changes(page)).toBe(2);
    } finally {
      page.stop();
    }
    await waitFor(() => handle.folderWatches.size() === 0);
  }, 20_000);

  it('opening the review checks a diff that moved while nobody had it open, once', async () => {
    writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n\nOne.\n');
    // timed: past a burst, so no watch opened below can hear this write.
    await new Promise((r) => setTimeout(r, PAST_A_BURST));
    const page = await open();
    try {
      await waitFor(() => changes(page) >= 1);
      // timed: a whole burst window, to prove the open sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      expect(row('guide.md')?.diffAdditions).toBe(2);
    } finally {
      page.stop();
    }
    // Unmoved since: the next open sends nothing.
    const again = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      // timed: a whole burst window, long enough for the opening pass.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(again)).toBe(0);
    } finally {
      again.stop();
    }
  }, 20_000);
});

describe('folder watch decisions', () => {
  /** A watch whose events the test fires by hand, over a listing it sets. */
  function harness() {
    let emit: (rel: string | null) => void = () => {};
    let closed = 0;
    const watch: WatchFn = (_root, onEvent) => {
      emit = onEvent;
      return { close: () => void closed++ };
    };
    const listing = new Set(['README.md', 'docs/guide.md']);
    let refreshes = 0;
    let passes = 0;
    const watches = createFolderWatches(
      {
        sourceOf: (id) => (id === 'set-1' ? { root: '/srv/harborlight' } : undefined),
        refresh: async () => void refreshes++,
      },
      {
        watch,
        listPaths: async () => {
          passes++;
          return new Set(listing);
        },
        settleMs: 5,
        maxWaitMs: 20,
      },
    );
    return {
      watches,
      listing,
      passes: () => passes,
      emit: (rel: string | null) => emit(rel),
      refreshes: () => refreshes,
      closed: () => closed,
    };
  }

  it('a save leaves the listing alone and refreshes nothing; an add and a delete do', async () => {
    const h = harness();
    h.watches.sync('set-1', 1);
    // The first burst always refreshes: its listing has no earlier one.
    h.emit('README.md');
    await waitFor(() => h.refreshes() === 1);
    h.emit('README.md.tmp-1');
    h.emit('README.md');
    await waitFor(() => h.passes() === 2);
    // The refresh decision follows the listing on the next turn.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.refreshes()).toBe(1);
    h.listing.add('tides.md');
    h.emit('tides.md');
    await waitFor(() => h.refreshes() === 2);
    h.listing.delete('docs/guide.md');
    h.emit('docs');
    await waitFor(() => h.refreshes() === 3);
    h.watches.dispose();
  });

  it('a burst of events is one pass', async () => {
    const h = harness();
    h.watches.sync('set-1', 1);
    for (let i = 0; i < 200; i++) h.emit(`note-${i}.md`);
    await waitFor(() => h.refreshes() === 1);
    // Two hundred events before the first timer fired: one listing.
    expect(h.passes()).toBe(1);
    h.watches.dispose();
  });

  it('ignores churn under .git and node_modules', () => {
    expect(isWatchedPath('.git/index')).toBe(false);
    expect(isWatchedPath('web/node_modules/a/index.js')).toBe(false);
    expect(isWatchedPath('.claude/rules/a.md')).toBe(true);
    expect(isWatchedPath('notes/tides.md')).toBe(true);
  });

  it('a board channel starts no watch, and release closes the handle', () => {
    const h = harness();
    h.watches.sync('board-1', 1);
    expect(h.watches.size()).toBe(0);
    h.watches.sync('set-1', 2);
    h.watches.sync('set-1', 1);
    expect(h.watches.size()).toBe(1);
    h.watches.sync('set-1', 0);
    expect(h.watches.size()).toBe(0);
    expect(h.closed()).toBe(1);
  });

  it('an atomic save on a real folder refreshes nothing; a new file does', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'folder-watch-save-'));
    try {
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      let refreshes = 0;
      let passes = 0;
      const watches = createFolderWatches(
        { sourceOf: () => ({ root: folder }), refresh: async () => void refreshes++ },
        {
          settleMs: 20,
          maxWaitMs: 100,
          listPaths: ({ root }) => {
            passes++;
            return folderListing(root);
          },
        },
      );
      watches.sync('set-1', 1);
      // The first burst is the one that always refreshes. Bun on Linux arms
      // its recursive watch a moment after the call returns, so keep writing
      // the same file until an event lands; rewrites leave the listing alone.
      await waitFor(() => {
        writeFileSync(join(folder, 'first.md'), '# Saltmarsh\n');
        return refreshes === 1;
      });
      const before = passes;
      writeFileSync(join(folder, 'README.md.tmp'), '# Harborlight, saved\n');
      renameSync(join(folder, 'README.md.tmp'), join(folder, 'README.md'));
      // A pass that saw the save ran, and compared equal.
      await waitFor(() => passes > before);
      await new Promise((r) => setTimeout(r, 0));
      expect(refreshes).toBe(1);
      writeFileSync(join(folder, 'tides.md'), '# Riverbend\n');
      await waitFor(() => refreshes === 2);
      watches.dispose();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
