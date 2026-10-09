/**
 * An open folder review hears a file created, deleted or renamed on disk.
 *
 * A review's file list is a disk scan, and nothing told an open page that
 * the disk moved: a file an agent wrote, a `git checkout`, an editor's new
 * file reached the tree only when the window regained focus. This watches
 * the folder for exactly as long as a page holds the review's stream
 * (`ws~<setId>`), and on a settled burst re-reconciles the review the way a
 * refresh does (`refreshWorkspace`), whose `onSetRescanned` sends the
 * `attachments.changed` frame the page already re-reads on
 * (`page-nudges.ts`, `workspaces-app/src/set-live.ts`).
 *
 * The rules, each from a way this has gone wrong before:
 *
 *   - ONLY WHAT A PAGE HAS OPEN. A watch starts on a channel's first page
 *     stream and closes with its last. Agent streams do not count: an agent
 *     never draws a tree. One watch per folder however many pages hold it,
 *     and at most `MAX_WATCHED_FOLDERS` in all.
 *   - DIRECTORY ENTRIES, NEVER CONTENTS. The trigger is one recursive
 *     `fs.watch` on the root (FSEvents on macOS: one stream per folder, not
 *     a handle per file). What an event meant is decided from a LISTING —
 *     `git ls-files` as a child process, or outside a repo an async
 *     `readdir` walk — both names only, both off the main thread, inside a
 *     deadline. Nothing here opens a file, so an online-only cloud file
 *     cannot answer EDEADLK or hang a read here.
 *   - A BURST IS ONE PASS. Events only mark the folder dirty. A pass runs
 *     after `SETTLE_MS` of quiet or `MAX_WAIT_MS` since the first event,
 *     and a pass in flight makes the next wait for it, so a `git checkout`
 *     of hundreds of files is one listing and at most one refresh.
 *   - A SAVE IS NOT NEWS. Editors save by renaming a temp file over the old
 *     one, which a directory watch reports like a new file. So the pass
 *     compares its listing with the last pass's and refreshes only when they
 *     differ: a file created, deleted or renamed. The first pass after a
 *     watch starts always refreshes, because the listing it would compare
 *     against may already hold a file whose event had not yet arrived.
 *
 * `fs.watch` is the wrong tool for following one FILE's contents
 * (learnings.md, "fs.watch is the wrong primitive"); a recursive directory
 * watch that only asks "did the listing change" is the use it is good for.
 */
import { watch as fsWatch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentIdOf } from '@claude-workspaces/core';
import type { DocMeta } from '@claude-workspaces/core';

/** Quiet time that closes a burst. */
export const SETTLE_MS = 150;
/** The longest a burst may gather before its pass runs anyway. */
export const MAX_WAIT_MS = 500;
/** Folders watched at once, server-wide. */
export const MAX_WATCHED_FOLDERS = 32;

/** Path segments whose churn never changes what a review lists. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

export type WatchFn = (
  root: string,
  onEvent: (relPath: string | null) => void,
) => { close(): void };

export interface FolderWatchHost {
  /** The folder a set lists from disk, or undefined when it has none to
   *  follow: a board channel, a pinned diff, a set with no root. */
  rootOf(setId: string): string | undefined;
  /** Re-reconcile the set against disk; its success sends the page frame. */
  refresh(setId: string): Promise<unknown>;
}

export interface FolderWatchOptions {
  watch?: WatchFn;
  /** Repo-relative paths a listing shows, or null when there is no listing. */
  listPaths?: (root: string) => Promise<Set<string> | null>;
  settleMs?: number;
  maxWaitMs?: number;
  maxFolders?: number;
}

export interface FolderWatches {
  /** A channel's page-stream count changed; hold or release its folder. */
  sync(setId: string, pages: number): void;
  /** Folders watched right now. */
  size(): number;
  dispose(): void;
}

/** The root of a set whose file list follows the working tree. */
export function liveRootOf(metas: readonly DocMeta[], setId: string): string | undefined {
  let root: string | undefined;
  for (const m of metas) {
    if (attachmentIdOf(m) !== setId) continue;
    // A pinned diff's files are a commit: the disk is not its source.
    if (m.type === 'diff' && m.diffTarget) return undefined;
    root ??= m.workspaceRoot;
  }
  return root;
}

/** Whether an event path can change a review's listing at all. */
export function isWatchedPath(relPath: string): boolean {
  return !relPath.split('/').some((seg) => IGNORED_SEGMENTS.has(seg));
}

/** Recursive directory watch; null filename means "something, unknown". */
const defaultWatch: WatchFn = (root, onEvent) => {
  const w = fsWatch(root, { recursive: true }, (_type, name) => {
    onEvent(typeof name === 'string' ? name.split('\\').join('/') : null);
  });
  w.on('error', () => w.close());
  return w;
};

/** Entries a listing walk reads before giving up on a folder. */
const MAX_WALK_ENTRIES = 20_000;
/** How long a listing may take before the watch does without one. */
const LISTING_DEADLINE_MS = 3_000;

/** `git ls-files` as a child process; null outside a repo or on failure. */
async function gitListing(root: string): Promise<Set<string> | null> {
  try {
    const proc = Bun.spawn(
      ['git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return new Set(text.split('\n').filter((l) => l.length > 0));
  } catch {
    return null;
  }
}

/**
 * Outside a repo: the folder's entries, read directory by directory off the
 * main thread. Names only — `readdir` never opens a file. Null when the walk
 * is too big or a directory will not answer.
 */
async function walkListing(root: string): Promise<Set<string> | null> {
  const out = new Set<string>();
  const dirs = [''];
  let seen = 0;
  while (dirs.length > 0) {
    const rel = dirs.pop() ?? '';
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return null;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_SEGMENTS.has(e.name)) dirs.push(path);
      } else out.add(path);
    }
  }
  return out;
}

/** The repo's listing, else the walk, either inside a deadline. */
export async function folderListing(root: string): Promise<Set<string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LISTING_DEADLINE_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const listed = (async () => (await gitListing(root)) ?? (await walkListing(root)))();
  try {
    return await Promise.race([listed, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether two listings name the same paths. */
export function sameListing(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

interface Watch {
  root: string;
  handle: { close(): void };
  /** The listing the last pass compared against; null before the first. */
  listed: Set<string> | null;
  /** The first burst refreshes whatever the listing says: a file written
   *  while the first listing ran may be in it before its event arrives. */
  first: boolean;
  dirty: boolean;
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  closed: boolean;
}

export function createFolderWatches(
  host: FolderWatchHost,
  opts: FolderWatchOptions = {},
): FolderWatches {
  const watchFn = opts.watch ?? defaultWatch;
  const listPaths = opts.listPaths ?? folderListing;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const maxFolders = opts.maxFolders ?? MAX_WATCHED_FOLDERS;
  const watches = new Map<string, Watch>();
  /** Channels already found to have no folder, until their pages leave. */
  const noFolder = new Set<string>();

  const run = async (setId: string, w: Watch): Promise<void> => {
    w.timer = null;
    if (w.closed) return;
    w.dirty = false;
    w.running = true;
    try {
      // Listed AFTER the burst's events arrived, so it already holds what
      // they did; a save leaves it unchanged.
      const now = await listPaths(w.root);
      const news = w.first || !now || !w.listed || !sameListing(now, w.listed);
      w.first = false;
      w.listed = now;
      if (news && !w.closed) await host.refresh(setId);
    } catch (err) {
      console.error('[folder-watch] pass failed:', err);
    } finally {
      w.running = false;
    }
    if (!w.closed && w.dirty) schedule(setId, w);
  };

  const schedule = (setId: string, w: Watch): void => {
    if (w.running || w.closed) return;
    if (w.timer) clearTimeout(w.timer);
    const waited = Date.now() - w.firstAt;
    const delay = Math.max(0, Math.min(settleMs, maxWaitMs - waited));
    w.timer = setTimeout(() => void run(setId, w), delay);
    (w.timer as { unref?: () => void }).unref?.();
  };

  const onEvent = (setId: string, w: Watch, rel: string | null): void => {
    if (w.closed) return;
    if (rel !== null && !isWatchedPath(rel)) return;
    if (!w.dirty && !w.timer) w.firstAt = Date.now();
    w.dirty = true;
    schedule(setId, w);
  };

  const start = (setId: string): void => {
    if (watches.size >= maxFolders) return;
    const root = host.rootOf(setId);
    if (!root) {
      noFolder.add(setId);
      return;
    }
    const w: Watch = {
      root,
      handle: { close() {} },
      listed: null,
      first: true,
      dirty: false,
      firstAt: 0,
      timer: null,
      running: false,
      closed: false,
    };
    try {
      w.handle = watchFn(root, (rel) => onEvent(setId, w, rel));
    } catch {
      // The root is gone or unreadable; the page keeps its focus re-read.
      noFolder.add(setId);
      return;
    }
    watches.set(setId, w);
  };

  const stop = (setId: string): void => {
    noFolder.delete(setId);
    const w = watches.get(setId);
    if (!w) return;
    watches.delete(setId);
    w.closed = true;
    if (w.timer) clearTimeout(w.timer);
    w.handle.close();
  };

  return {
    sync(setId, pages) {
      if (pages === 0) stop(setId);
      else if (!watches.has(setId) && !noFolder.has(setId)) start(setId);
    },
    size: () => watches.size,
    dispose() {
      for (const id of [...watches.keys()]) stop(id);
      noFolder.clear();
    },
  };
}
