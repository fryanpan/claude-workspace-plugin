/**
 * Incoming Messages tells the workspaces list's feed about every write, and
 * about a snooze ending when nobody writes (`inbox/live.ts`). The clock and
 * the timer are injected; the store is the real one over a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchInbox } from '../src/inbox/live.ts';
import { InboxStore } from '../src/inbox/store.ts';
import type { InboxRowInput } from '../src/inbox/types.ts';
import { validateRow } from '../src/inbox/validate.ts';
import { CONFIG, NOW, row } from './inbox-fixtures.ts';

let dir: string;
let now: number;
let store: InboxStore;
let timers: Array<{ fn: () => void; at: number; live: boolean }>;
let notified: number;
let stop: () => void;

const schedule = (fn: () => void, ms: number) => {
  const t = {
    fn: () => {
      t.live = false;
      fn();
    },
    at: now + ms,
    live: true,
  };
  timers.push(t);
  return () => {
    t.live = false;
  };
};
const pending = () => timers.filter((t) => t.live);
const input = (): InboxRowInput => {
  const v = validateRow(row(), { config: CONFIG, now, goalIsLive: () => false });
  if (!v.ok) throw new Error(v.reason);
  return v.row;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-live-'));
  now = NOW;
  store = new InboxStore(dir, () => now);
  timers = [];
  notified = 0;
  stop = watchInbox({ store, notify: () => (notified += 1), now: () => now, schedule });
});

afterEach(() => {
  stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('watchInbox', () => {
  it('tells the feed about a post and a tap', () => {
    store.post([input()], 'p-1');
    expect(notified).toBeGreaterThan(0);
    const before = notified;
    const id = store.list()[0]?.id ?? '';
    expect(store.act(id, { kind: 'remove' }).ok).toBe(true);
    expect(notified).toBeGreaterThan(before);
  });

  it('re-reads the store when a snooze ends, so the row comes back on its own', () => {
    store.post([input()], 'p-1');
    const id = store.list()[0]?.id ?? '';
    const until = now + 3_600_000;
    expect(store.act(id, { kind: 'snooze', until }).ok).toBe(true);
    const timer = pending().at(-1);
    expect(timer?.at).toBe(until);
    const before = notified;
    now = until;
    timer?.fn();
    expect(store.get(id)?.state).toBe('open');
    expect(notified).toBeGreaterThan(before);
    expect(pending()).toHaveLength(0);
  });

  it('stops listening once unwired', () => {
    stop();
    store.post([input()], 'p-1');
    expect(notified).toBe(0);
  });
});
