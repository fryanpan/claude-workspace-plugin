/**
 * The edit-session tracker on its own: how edits coalesce, when a session
 * closes, what a transaction counts as, and that the row it becomes is one
 * the rest of the activity tooling reads without complaint.
 *
 * The end-to-end half — a real socket and a real edit route — is
 * `edit-session-activity.test.ts`. All fixtures are invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocMeta } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { repairActivityOwner } from '../src/activity-repair-owner.ts';
import { activityLogPath } from '../src/activity.ts';
import type { LiveDoc } from '../src/doc-store.ts';
import {
  type ClosedEditSession,
  type EditAuthor,
  EditSessionTracker,
  editAuthorOf,
  editSessionEvent,
  editStatsOf,
} from '../src/edit-sessions.ts';
import { withEventOrigin } from '../src/event-origin.ts';
import { readingTimeTotalsFromLog } from '../src/reading-time-backfill.ts';
import { isAnalyticsOnlyEvent } from '../src/review-items/analytics.ts';
import { waitFor } from './wait-for.ts';

const ALICE: EditAuthor = {
  source: 'editor',
  actor: 'person',
  actorId: 'user-alice',
  actorName: 'Alice',
  isOwner: false,
  key: 'id:user-alice',
};
const AGENT: EditAuthor = { source: 'mcp', actor: 'agent', isOwner: false, key: 'mcp' };
const TYPING = { charsInserted: 3, charsDeleted: 1, blocks: null };

const trackers: EditSessionTracker[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tracker(opts: { idleMs?: number; maxSessionMs?: number } = {}) {
  const closed: ClosedEditSession[] = [];
  const t = new EditSessionTracker({ ...opts, emit: (s) => closed.push(s) });
  trackers.push(t);
  return { t, closed };
}

describe('EditSessionTracker', () => {
  it('folds edits inside the idle window into one session, written once it goes quiet', async () => {
    const { t, closed } = tracker({ idleMs: 40 });
    t.note('d1', ALICE, TYPING);
    t.note('d1', ALICE, TYPING);
    t.note('d1', ALICE, TYPING);
    expect(closed).toHaveLength(0);
    await waitFor(() => closed.length === 1);
    expect(closed[0]).toMatchObject({
      docId: 'd1',
      editCount: 3,
      charsInserted: 9,
      charsDeleted: 3,
    });
    expect(closed[0]?.author.actorId).toBe('user-alice');
    expect(t.openCount()).toBe(0);
  });

  it('starts a second session for an edit after the window closed', async () => {
    const { t, closed } = tracker({ idleMs: 30 });
    t.note('d1', ALICE, TYPING);
    await waitFor(() => closed.length === 1);
    t.note('d1', ALICE, TYPING);
    await waitFor(() => closed.length === 2);
    expect(closed.map((s) => s.editCount)).toEqual([1, 1]);
    expect(closed[0]?.sessionId).not.toBe(closed[1]?.sessionId);
  });

  it('keeps a person and an agent on the same doc in separate sessions', () => {
    const { t, closed } = tracker();
    t.note('d1', ALICE, TYPING);
    t.note('d1', AGENT, TYPING);
    t.note('d1', ALICE, TYPING);
    t.closeAll();
    const bySource = Object.fromEntries(closed.map((s) => [s.author.source, s.editCount]));
    expect(bySource).toEqual({ editor: 2, mcp: 1 });
  });

  it('splits a sitting that outlasts the longest session', () => {
    const { t, closed } = tracker({ maxSessionMs: 0 });
    t.note('d1', ALICE, TYPING);
    t.note('d1', ALICE, TYPING);
    expect(closed).toHaveLength(1);
    t.closeAll();
    expect(closed).toHaveLength(2);
  });

  it('writes a doc’s open sessions when the doc leaves memory, and only that doc’s', () => {
    const { t, closed } = tracker();
    t.note('d1', ALICE, TYPING);
    t.note('d2', ALICE, TYPING);
    t.closeDoc('d1');
    expect(closed.map((s) => s.docId)).toEqual(['d1']);
    expect(t.openCount()).toBe(1);
  });

  it('counts distinct blocks across the session', () => {
    const { t, closed } = tracker();
    const a = {};
    const b = {};
    t.note('d1', ALICE, { charsInserted: 1, charsDeleted: 0, blocks: [a] });
    t.note('d1', ALICE, { charsInserted: 1, charsDeleted: 0, blocks: [a, b] });
    t.closeAll();
    expect(closed[0]?.blocksTouched).toBe(2);
  });
});

describe('editAuthorOf', () => {
  // The string branch reads nothing off the doc but its connection set.
  const doc = { conns: new Set() } as unknown as LiveDoc;

  it('files an agent-origin edit made inside a non-browser request as mcp', async () => {
    const author = await withEventOrigin({}, async () => editAuthorOf(doc, 'agent'));
    expect(author).toMatchObject({ source: 'mcp', actor: 'agent', isOwner: false });
  });

  it('records no agent-origin edit made outside a request, as the meeting assistant’s are', () => {
    expect(editAuthorOf(doc, 'agent')).toBeNull();
  });

  it('records no agent-origin edit a browser request made, and no housekeeping', async () => {
    const browser = { device: { kind: 'desktop' as const, browser: 'Chrome' } };
    expect(await withEventOrigin(browser, async () => editAuthorOf(doc, 'agent'))).toBeNull();
    expect(await withEventOrigin({}, async () => editAuthorOf(doc, 'agent-reanchor'))).toBeNull();
    expect(await withEventOrigin({}, async () => editAuthorOf(doc, undefined))).toBeNull();
  });

  it('records no edit from a socket this doc does not hold', () => {
    expect(editAuthorOf(doc, { data: {} })).toBeNull();
  });
});

describe('editStatsOf', () => {
  function capture(ydoc: Y.Doc, fn: () => void): Y.Transaction {
    let tr: Y.Transaction | null = null;
    const on = (t: Y.Transaction) => {
      tr = t;
    };
    ydoc.on('afterTransaction', on);
    ydoc.transact(fn);
    ydoc.off('afterTransaction', on);
    if (!tr) throw new Error('no transaction');
    return tr;
  }

  it('counts inserted and deleted characters and the block they were in', () => {
    const ydoc = new Y.Doc();
    const frag = getProseFragment(ydoc);
    const text = new Y.XmlText();
    ydoc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [text]);
      frag.push([p]);
      text.insert(0, 'Saltmarsh');
    });
    const typed = capture(ydoc, () => text.insert(9, ' flats'));
    expect(editStatsOf(typed, frag, true)).toMatchObject({ charsInserted: 6, charsDeleted: 0 });
    expect(editStatsOf(typed, frag, true)?.blocks).toHaveLength(1);
    const deleted = capture(ydoc, () => text.delete(0, 4));
    expect(editStatsOf(deleted, frag, true)).toMatchObject({ charsInserted: 0, charsDeleted: 4 });
  });

  it('ignores a transaction that left the body alone', () => {
    const ydoc = new Y.Doc();
    const frag = getProseFragment(ydoc);
    const meta = capture(ydoc, () => ydoc.getMap('meta').set('title', 'Riverbend'));
    expect(editStatsOf(meta, frag, true)).toBeNull();
  });
});

describe('the edit_session row', () => {
  const meta = { docId: 'd1', type: 'markdown', title: 'Tides' } as DocMeta;
  const session: ClosedEditSession = {
    docId: 'd1',
    sessionId: 's-1',
    author: { ...ALICE, device: { kind: 'ipad', browser: 'Safari' } },
    startMs: Date.parse('2026-09-01T10:00:00.000Z'),
    endMs: Date.parse('2026-09-01T10:04:30.000Z'),
    editCount: 12,
    charsInserted: 140,
    charsDeleted: 20,
    blocksTouched: 3,
  };

  it('carries the read_session envelope and the session payload', () => {
    const ev = editSessionEvent(session, meta);
    expect(ev).toMatchObject({
      type: 'edit_session',
      ts: '2026-09-01T10:04:30.000Z',
      actor: 'person',
      actorId: 'user-alice',
      actorName: 'Alice',
      isOwner: false,
      device: { kind: 'ipad', browser: 'Safari' },
      payload: {
        sessionId: 's-1',
        source: 'editor',
        startTs: '2026-09-01T10:00:00.000Z',
        endTs: '2026-09-01T10:04:30.000Z',
        durationMs: 270_000,
        editCount: 12,
        charsInserted: 140,
        charsDeleted: 20,
        blocksTouched: 3,
      },
    });
    expect(ev.eventId).toMatch(/^[0-9a-f]{24}$/);
    expect(ev.payload.text).toBeUndefined();
    expect(isAnalyticsOnlyEvent('edit_session')).toBe(true);
  });

  it('passes through the owner repair and is not counted as reading time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-session-row-'));
    dirs.push(dir);
    const line = JSON.stringify(editSessionEvent(session, meta));
    writeFileSync(activityLogPath(dir), `${line}\n`);
    const stats = repairActivityOwner({ dataDir: dir, write: false });
    expect(stats).toMatchObject({ rows: 1, unparseable: 0, falseToTrue: 0, trueToFalse: 0 });
    expect(readFileSync(activityLogPath(dir), 'utf8')).toBe(`${line}\n`);
    const reading = readingTimeTotalsFromLog(dir);
    expect(reading).toMatchObject({ linesScanned: 1, readSessionsFolded: 0 });
  });
});
