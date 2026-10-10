/**
 * A run's output item leaves once its files are read, however they were
 * opened (`task-run-output.ts`, `noteOutputOpened`).
 *
 * The case that went wrong: the run's writer binds each digest as a doc of
 * its own before the run closes. The item used to wait only on files no doc
 * held when it was filed, so it waited on nothing and stood until the next
 * run replaced it, however many times the reader opened the digest. Opening
 * now means a reader asked for the file — its doc page's record, or the
 * Library's open — after the item was filed.
 *
 * End to end on a real server over a real git repo, the scheduler's clock
 * injected (`schedulerNow`) and never ticking on its own. Fixtures are
 * invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type User, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { fsStampNow } from './fs-stamp.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { listenFrames, waitForFrames } from './sse-frames.ts';
import { DAY, OWNER, instancesOf } from './task-scheduler-seed.ts';
import { waitFor } from './wait-for.ts';

const ALICE: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const MIN = 60_000;

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('a run’s output item and the doc page', () => {
  let dataDir: string;
  let repo: string;
  let handle: ServerHandle;
  let base: string;
  let ws: string;
  let now = Date.now();

  const headers = () => ({ 'content-type': 'application/json', host: `localhost:${handle.port}` });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const getJson = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${base}${path}`, { headers: headers() })).json()) as T;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'run-output-read-data-'));
    repo = mkdtempSync(join(tmpdir(), 'run-output-read-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Harborlight handbook\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    now = Date.now();
    handle = createServer({
      port: 0,
      dataDir,
      schedulerNow: () => now,
      schedulerTickMs: 3_600_000,
    });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = (await (
      await post('/workspaces', { name: 'Harborlight', goal: 'Read the digests.' })
    ).json()) as { workspace: { id: string } };
    ws = workspace.id;
    const bound = await post(`/workspaces/${ws}/docs`, {
      docId: 'handbook',
      type: 'markdown',
      sourceUrl: join(repo, 'handbook.md'),
      title: 'Harborlight handbook',
    });
    expect(bound.status).toBe(200);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * One run of a digest rule that writes `files` into `digests/` and binds
   * each as its own doc of the board before the run closes, the way the
   * writer does. Answers the rule's id and the doc id of each file.
   */
  async function runBindingDigests(files: string[]) {
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'g1', title: '1. Digests' }], ALICE);
    const { task: rule } = (await (
      await post(`/workspaces/${ws}/tasks`, {
        author: ALICE,
        title: 'Write the Riverbend digest',
        goal: G.g1,
      })
    ).json()) as { task: { id: string } };
    const armed = await post(`/workspaces/${ws}/tasks/${rule.id}/schedule`, {
      author: ALICE,
      rule: { kind: 'every', everyMs: DAY },
      output: { folder: 'digests' },
    });
    expect(armed.status).toBe(200);
    now += DAY + MIN;
    expect(handle.runScheduler()).toHaveLength(1);
    const [instance] = instancesOf(handle.tasks, ws, rule.id);
    if (!instance) throw new Error('no instance');
    // A file counts as the run's only if its mtime is at or after the
    // instance's `createdAt`, and a Linux file clock can read behind
    // `Date.now()`: a digest written straight away is stamped before its own
    // run, the item links only the later digest, and opening the first one
    // finds nothing to offer.
    const startedAt = instance.createdAt;
    await waitFor(() => fsStampNow() >= startedAt, {
      describe: 'a new file to be stamped inside the run',
    });
    mkdirSync(join(repo, 'digests'), { recursive: true });
    const docIds: string[] = [];
    for (const rel of files) {
      writeFileSync(join(repo, rel), `# ${rel}\n\nThree notes from Saltmarsh.\n`);
      const res = await post(`/workspaces/${ws}/docs`, {
        docId: rel.replace(/[/.]/g, '-'),
        type: 'markdown',
        sourceUrl: join(repo, rel),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { doc?: { docId?: string }; docId?: string };
      docIds.push(body.doc?.docId ?? body.docId ?? '');
    }
    expect(handle.tasks.transition(instance.id, 'done', { actor: OWNER }).ok).toBe(true);
    handle.runScheduler();
    return { ruleId: rule.id, docIds };
  }

  const standing = (ruleId: string) =>
    handle.tasks
      .listReviewItems(ruleId)
      .filter((i) => isReviewItemOpen(i) && !reviewWithdrawn(i.review));
  const readRecord = (docId: string) =>
    getJson<{ linkedItems?: Array<{ reviewItemId: string; markRead?: boolean }> }>(
      `/workspaces/${ws}/docs/${encodeURIComponent(docId)}?format=json`,
    );

  it('leaves once its one digest, bound before the item was filed, is opened at the doc URL', async () => {
    const { ruleId, docIds } = await runBindingDigests(['digests/riverbend-1008.md']);
    expect(standing(ruleId).map((i) => i.review.headline)).toEqual([
      'New in digests: riverbend-1008.md',
    ]);
    await readRecord(docIds[0] ?? '');
    handle.runScheduler();
    expect(standing(ruleId)).toEqual([]);
    expect(handle.tasks.listReviewItems(ruleId)).toHaveLength(1);
  });

  it('leaves once its digest is opened through the Library link instead', async () => {
    const { ruleId } = await runBindingDigests(['digests/riverbend-1008.md']);
    const res = await post(`/workspaces/${ws}/library/open`, { path: 'digests/riverbend-1008.md' });
    expect(res.status).toBe(200);
    expect(standing(ruleId)).toEqual([]);
  });

  it('offers Mark read on each file it still waits on, which closes it and tells an open Home', async () => {
    const { ruleId, docIds } = await runBindingDigests([
      'digests/riverbend-1008.md',
      'digests/saltmarsh-1008.md',
    ]);
    const [item] = standing(ruleId);
    if (!item) throw new Error('no item');
    // Reading one of two leaves the item up, and the page offers to close it.
    const record = await readRecord(docIds[0] ?? '');
    expect(standing(ruleId)).toHaveLength(1);
    expect(record.linkedItems).toEqual([
      expect.objectContaining({ reviewItemId: item.id, markRead: true }),
    ]);

    const home = await fetch(`${base}/workspaces/${ws}/events:stream`, { headers: headers() });
    const stream = listenFrames(home);
    try {
      const marked = await post(
        `/workspaces/${ws}/tasks/${ruleId}/review-items/${item.id}/withdraw`,
        { author: ALICE, reason: 'marked read' },
      );
      expect(marked.status).toBe(200);
      expect(standing(ruleId)).toEqual([]);
      const frames = await waitForFrames(stream.frames, 'review_item.withdrawn', 1);
      expect(frames[0]?.data?.reviewItemId).toBe(item.id);
      const queue = JSON.stringify(await getJson(`/workspaces/${ws}/review-items`));
      expect(queue).not.toContain('New in digests');
    } finally {
      await stream.stop();
    }
    // A closed item docks nowhere.
    expect((await readRecord(docIds[1] ?? '')).linkedItems).toBeUndefined();
  });

  it('unsticks an item filed before this change, which waits on nothing', async () => {
    const { ruleId, docIds } = await runBindingDigests(['digests/riverbend-1008.md']);
    const output = handle.tasks.getTask(ruleId)?.schedule?.state?.output;
    if (!output?.item) throw new Error('no standing item');
    output.item.waitingOn = [];
    await readRecord(docIds[0] ?? '');
    expect(standing(ruleId)).toEqual([]);
  });
});
