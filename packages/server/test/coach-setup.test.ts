/**
 * Workflow A's first step and the coach's composition: "Set up my coach"
 * makes one doc on a board of its own and never overwrites a file, "Add a
 * goal" numbers after the rest, and the live activity feed reaches the coach
 * of its own data dir only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Event, appendActivity } from '../src/activity.ts';
import { goalsDocTemplate } from '../src/coach/goals-doc.ts';
import { type CoachSetupDeps, addGoal, ensureGoalsDoc, goalsDocPath } from '../src/coach/setup.ts';
import { CoachStore } from '../src/coach/store.ts';
import { REVIEW_AFTER_MS } from '../src/coach/types.ts';
import { type CoachWiringDeps, wireCoach } from '../src/coach/wiring.ts';
import { GOALS_DOC, at } from './coach-fixtures.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-setup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A doc store and task store in memory, recording what was asked. */
function fakes(dataDir: string) {
  const docs = new Map<string, string>();
  const boards: string[] = [];
  const filed: [string, string][] = [];
  const deps: CoachSetupDeps = {
    dataDir,
    createBoard: (name) => {
      boards.push(name);
      return `w-${boards.length}`;
    },
    createDoc: async (docId, path, _title, ws) => {
      docs.set(docId, readFileSync(path, 'utf8'));
      filed.push([docId, ws]);
      return docId;
    },
    docExists: (id) => docs.has(id),
    readMarkdown: (id) => docs.get(id) ?? null,
    appendMarkdown: (id, md) => {
      docs.set(id, `${docs.get(id) ?? ''}\n${md}`);
      return true;
    },
  };
  return { deps, docs, boards, filed };
}

describe('ensureGoalsDoc', () => {
  it('makes the doc once, on a board named Coach, from the template, owner-only', async () => {
    const store = new CoachStore(dir, at(9));
    const f = fakes(dir);
    const first = await ensureGoalsDoc(store, f.deps, at(9));
    const again = await ensureGoalsDoc(store, f.deps, at(10));
    expect(again).toEqual(first);
    expect(f.boards).toEqual(['Coach']);
    expect(f.filed).toEqual([[first?.docId ?? '', 'w-1']]);
    expect(f.docs.get(first?.docId ?? '')).toBe(goalsDocTemplate());
    expect(statSync(goalsDocPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('keeps a file that is already there, and re-binds it on the same board', async () => {
    mkdirSync(join(dir, 'coach'), { recursive: true });
    writeFileSync(goalsDocPath(dir), GOALS_DOC);
    const store = new CoachStore(dir, at(9));
    store.setGoalsDoc({ workspaceId: 'w-9', docId: 'd-gone', createdAt: at(8) });
    const f = fakes(dir);
    const doc = await ensureGoalsDoc(store, f.deps, at(9));
    expect(doc?.workspaceId).toBe('w-9');
    expect(f.boards).toEqual([]);
    expect(f.docs.get(doc?.docId ?? '')).toBe(GOALS_DOC);
  });
});

describe('addGoal', () => {
  it('appends the next goal number after the ones already there', async () => {
    const store = new CoachStore(dir, at(9));
    const f = fakes(dir);
    expect(addGoal(store, f.deps)).toBe(false);
    const doc = await ensureGoalsDoc(store, f.deps, at(9));
    f.docs.set(doc?.docId ?? '', GOALS_DOC);
    expect(addGoal(store, f.deps)).toBe(true);
    expect(f.docs.get(doc?.docId ?? '')).toContain('## Goal 3\n\n### What I want to do better');
  });
});

describe('wireCoach', () => {
  function wire(dataDir: string, md: string | null) {
    const docStore: CoachWiringDeps['docStore'] = {
      prewarmHydration: async () => undefined,
      createForCaller: (docId) => ({ ok: true, doc: { docId } }),
      attachFileAsync: async () => ({ ok: true }),
      docExists: () => md !== null,
      readMarkdownBody: () => md,
      applyBlockEdits: () => ({ ok: true }),
    };
    return wireCoach({
      dataDir,
      docStore,
      createBoard: () => 'w-coach',
      fileUnderBoard: () => {},
      label: () => ({}),
      boardName: () => undefined,
      workspaceOf: () => 'w-coach',
      generate: null,
      now: () => at(9),
    });
  }

  it('draws Set up before there is a doc, and the named coach and goals after', () => {
    const before = wire(dir, null);
    expect(before.landing()).toContain('data-act="setup"');
    before.stop();
    const after = wire(dir, GOALS_DOC);
    after.store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: at(9) });
    const page = after.landing();
    expect(page).toContain('<h2 id="coach-h">Saltmarsh</h2>');
    expect(page).toContain('<li>Answer people who are waiting on me the same day.</li>');
    after.stop();
  });

  it('hears an activity row written in its own data dir, and not in another', () => {
    const other = mkdtempSync(join(tmpdir(), 'coach-other-'));
    const w = wire(dir, GOALS_DOC);
    const old = at(9) - 2 * REVIEW_AFTER_MS;
    w.store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: old });
    const row = {
      eventId: 'ev-1',
      ts: new Date(at(9)).toISOString(),
      type: 'edit_session',
      actor: 'person',
      isOwner: true,
      doc: { docId: 'd-goals' },
      payload: {},
    } as unknown as Event;
    appendActivity(other, row);
    expect(w.store.reviewDue(at(9))).toBe(true);
    appendActivity(dir, row);
    expect(w.store.reviewDue(at(9))).toBe(false);
    w.stop();
    rmSync(other, { recursive: true, force: true });
  });
});
