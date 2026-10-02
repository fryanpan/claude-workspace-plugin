/**
 * The inbox store: upsert by source thread id, the five retire flows Bryan
 * has (snooze, dismiss with a reason, answer, reopen, undo), the two moves a
 * pass can make, and that nothing is ever removed from the file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxBodies } from '../src/inbox/bodies.ts';
import { InboxStore } from '../src/inbox/store.ts';
import { ARCHIVE_AFTER_MS, type InboxRowInput, MAX_OPEN_ROWS } from '../src/inbox/types.ts';
import { validateRow } from '../src/inbox/validate.ts';
import { CONFIG, NOW, row } from './inbox-fixtures.ts';

let dir: string;
let clock: number;
const store = () => new InboxStore(dir, () => clock);

/** A row through the real checks, as the route stores it. */
function input(over: Record<string, unknown> = {}): InboxRowInput {
  const v = validateRow(row(over), { config: CONFIG, now: clock, goalIsLive: () => false });
  if (!v.ok) throw new Error(v.reason);
  return v.row;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-store-'));
  clock = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('post', () => {
  it('creates a row once and updates it by dedupe key on the next pass', () => {
    const s = store();
    const first = input();
    const a = s.post([first], 'p1');
    expect(a).toMatchObject({ ok: true, created: 1, updated: 0 });
    const b = s.post([{ ...first, purpose: 'Now wants the 15th instead' }], 'p2');
    expect(b).toMatchObject({ ok: true, created: 0, updated: 1 });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.purpose).toBe('Now wants the 15th instead');
    expect(s.lastPass()).toEqual({ at: NOW, pass: 'p2' });
  });

  it('a thread Bryan last replied to arrives answered, and an open one moves to answered', () => {
    const s = store();
    const mine = input({ lastFromOwner: true });
    const theirs = input();
    s.post([mine, theirs], 'p1');
    const [m, t] = s.list();
    expect(m?.state).toBe('answered');
    expect(t?.state).toBe('open');
    s.post([{ ...theirs, lastFromOwner: true, messageCount: 2 }], 'p2');
    expect(s.get(t?.id ?? '')?.state).toBe('answered');
    expect(s.get(t?.id ?? '')?.history.at(-1)).toMatchObject({
      by: 'reader',
      why: 'replied-in-app',
    });
  });

  it('a new message on an answered thread reopens it; the same count does not', () => {
    const s = store();
    const r = input();
    s.post([r], 'p1');
    const id = s.list()[0]?.id ?? '';
    s.act(id, { kind: 'answer' });
    s.post([r], 'p2');
    expect(s.get(id)?.state).toBe('answered');
    s.post([{ ...r, messageCount: 2 }], 'p3');
    expect(s.get(id)?.state).toBe('open');
    expect(s.get(id)?.history.at(-1)).toMatchObject({ by: 'reader', why: 'new-message' });
  });

  it('a dismissed thread stays dismissed when its next message arrives', () => {
    const s = store();
    const r = input();
    s.post([r], 'p1');
    const id = s.list()[0]?.id ?? '';
    s.act(id, { kind: 'dismiss', reason: 'spam' });
    s.post([{ ...r, messageCount: 3 }], 'p2');
    expect(s.get(id)?.state).toBe('dismissed');
  });

  it('refuses a whole pass that would leave more than the cap open, storing nothing', () => {
    const s = store();
    const many = Array.from({ length: MAX_OPEN_ROWS }, () => input());
    for (let i = 0; i < many.length; i += 40) s.post(many.slice(i, i + 40), `p${i}`);
    expect(s.counts().open).toBe(MAX_OPEN_ROWS);
    const over = s.post([input()], 'over');
    expect(over).toEqual({ ok: false, error: 'too-many-open' });
    expect(s.list()).toHaveLength(MAX_OPEN_ROWS);
    // An update to a row already held is not a new open row.
    expect(s.post([many[0] as InboxRowInput], 'again').ok).toBe(true);
  });
});

describe("Bryan's taps", () => {
  const seeded = () => {
    const s = store();
    s.post([input()], 'p1');
    return { s, id: s.list()[0]?.id ?? '' };
  };

  it('snooze hides the row until its time, then it comes back open by itself', () => {
    const { s, id } = seeded();
    expect(s.act(id, { kind: 'snooze', until: NOW + 3_600_000 })).toMatchObject({
      ok: true,
      row: { state: 'snoozed', snoozedUntil: NOW + 3_600_000 },
    });
    clock = NOW + 3_600_000;
    expect(store().get(id)).toMatchObject({ state: 'open' });
    expect(store().get(id)?.history.at(-1)).toMatchObject({ why: 'snooze-ended' });
    expect(store().get(id)?.snoozedUntil).toBeUndefined();
  });

  it('refuses a snooze in the past, too far ahead, or not a whole number', () => {
    const { s, id } = seeded();
    for (const until of [NOW, NOW - 1, NOW + 367 * 86_400_000, NOW + 0.5]) {
      expect(s.act(id, { kind: 'snooze', until })).toMatchObject({ ok: false, status: 400 });
    }
    expect(s.get(id)?.state).toBe('open');
  });

  it('dismiss keeps its reason; answer and dismiss refuse a row already retired', () => {
    const { s, id } = seeded();
    expect(s.act(id, { kind: 'dismiss', reason: 'handled-elsewhere' })).toMatchObject({
      ok: true,
      row: { state: 'dismissed', dismissReason: 'handled-elsewhere' },
    });
    expect(s.act(id, { kind: 'answer' })).toMatchObject({ ok: false, error: 'already-retired' });
    expect(s.act(id, { kind: 'reopen' })).toMatchObject({ ok: true, row: { state: 'open' } });
    expect(s.get(id)?.dismissReason).toBeUndefined();
    expect(s.act(id, { kind: 'reopen' })).toMatchObject({ ok: false, error: 'already-open' });
  });

  it('undo puts back exactly what the last tap changed, snooze time and reason included', () => {
    const { s, id } = seeded();
    s.act(id, { kind: 'snooze', until: NOW + 7_200_000 });
    s.act(id, { kind: 'reopen' });
    expect(s.act(id, { kind: 'undo' })).toMatchObject({
      ok: true,
      row: { state: 'snoozed', snoozedUntil: NOW + 7_200_000 },
    });
    s.act(id, { kind: 'reopen' });
    s.act(id, { kind: 'dismiss', reason: 'not-needed' });
    s.act(id, { kind: 'reopen' });
    expect(s.act(id, { kind: 'undo' })).toMatchObject({
      ok: true,
      row: { state: 'dismissed', dismissReason: 'not-needed' },
    });
    // An undo is not itself undone, and a pass's move is not Bryan's to undo.
    expect(s.act(id, { kind: 'undo' })).toMatchObject({ ok: false, error: 'nothing-to-undo' });
  });

  it('an unknown id is a 404', () => {
    expect(store().act('ib-AAAAAAAAAAAA', { kind: 'answer' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('soft delete', () => {
  it('archives a row retired for thirty days, and keeps it, with its history, in the file', () => {
    const s = store();
    s.post([input()], 'p1');
    const id = s.list()[0]?.id ?? '';
    s.act(id, { kind: 'answer' });
    clock = NOW + ARCHIVE_AFTER_MS - 1;
    expect(store().list()).toHaveLength(1);
    clock = NOW + ARCHIVE_AFTER_MS;
    expect(store().list()).toHaveLength(0);
    const file = JSON.parse(readFileSync(join(dir, 'inbox', 'rows.json'), 'utf8'));
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]).toMatchObject({
      id,
      state: 'answered',
      archivedAt: NOW + ARCHIVE_AFTER_MS,
    });
    expect(file.rows[0].history.length).toBeGreaterThan(0);
    // Reopening an archived row brings it back to the live list.
    expect(store().act(id, { kind: 'reopen' })).toMatchObject({ ok: true });
    expect(
      store()
        .list()
        .map((r) => r.id),
    ).toEqual([id]);
  });

  it('writes its files mode 600 in a 700 directory, and keeps bodies apart from rows', () => {
    const s = store();
    s.post([input()], 'p1');
    const id = s.list()[0]?.id ?? '';
    new InboxBodies(dir).putAll([[id, 'Hold the 14th?']]);
    expect(statSync(join(dir, 'inbox', 'rows.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'inbox', 'bodies.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'inbox')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, 'inbox', 'rows.json'), 'utf8')).not.toContain('Hold the 14th');
    expect(new InboxBodies(dir).get(id)).toBe('Hold the 14th?');
    expect(new InboxBodies(dir).get('__proto__')).toBeUndefined();
  });
});
