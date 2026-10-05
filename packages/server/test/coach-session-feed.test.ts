/**
 * The coach session's feed: a frame is addressed on the Coach board to its
 * lead, and only while that lead holds a stream, so a session that is gone
 * returns to no backlog. What he does arrives as one digest per window, at
 * most every 15 minutes and only when the window holds something; his
 * answers and his setting arrive as they happen.
 */
import { describe, expect, it } from 'bun:test';
import { DIGEST_WINDOW_MS, SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';

/** A clock and a timer the test moves by hand. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.live = false;
        next.fn();
      }
      now = end;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

function feed(
  opts: {
    lead?: boolean;
    connected?: boolean;
    took?: number;
    today?: number;
    limit?: number;
    time?: ReturnType<typeof fakeTime>;
  } = {},
) {
  const sent: [string, string, SessionFrame][] = [];
  const turns: number[] = [];
  const time = opts.time ?? fakeTime();
  const f = new SessionFeed({
    now: time.now,
    schedule: time.schedule,
    countTurn: (at) => turns.push(at),
    lead: () => (opts.lead === false ? null : { workspaceId: 'w-coach', agentId: 'agent-coach' }),
    connected: () => opts.connected ?? true,
    send: (ws, agent, frame) => {
      sent.push([ws, agent, frame]);
      return opts.took ?? 1;
    },
    eventsOn: () => opts.today ?? 0,
    ...(opts.limit === undefined ? {} : { dailyLimit: opts.limit }),
  });
  return { f, sent, turns, time };
}

const viewNews = (docId: string) => ({
  event: 'coach.event' as const,
  kind: 'view' as const,
  boardId: 'w-harbor',
  board: 'Harborlight',
  docId,
  text: 'The passage in view.',
});

describe('SessionFeed', () => {
  it('addresses each frame to the lead on the Coach board, stamped with its time', () => {
    const { f, sent } = feed();
    expect(f.reachable()).toBe(true);
    expect(f.send({ event: 'coach.preference', readiness: 'more' }, 42)).toBe(true);
    expect(sent).toEqual([
      [
        'w-coach',
        'agent-coach',
        { event: 'coach.preference', readiness: 'more', workspaceId: 'w-coach', at: 42 },
      ],
    ]);
  });

  it('sends nothing with no lead or a lead holding no stream, and says when no stream took it', () => {
    for (const opts of [{ lead: false }, { connected: false }]) {
      const { f, sent } = feed(opts);
      expect(f.reachable()).toBe(false);
      expect(f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(false);
      expect(sent).toEqual([]);
    }
    expect(feed({ took: 0 }).f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(
      false,
    );
  });

  it('sends nothing once the day’s turns reach the budget, 400 by default', () => {
    const under = feed({ today: 399 });
    expect(under.f.paused(1)).toBe(false);
    expect(under.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(true);
    const at = feed({ today: 400 });
    expect(at.f.paused(1)).toBe(true);
    expect(at.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(false);
    expect(at.sent).toEqual([]);
    const lower = feed({ today: 3, limit: 3 });
    expect(lower.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(false);
  });
});

describe('the digest', () => {
  it('turns 50 views in 15 minutes into one frame, sent when the window closes', () => {
    const { f, sent, turns, time } = feed();
    const start = time.now();
    for (let i = 0; i < 50; i += 1) {
      expect(f.send(viewNews(i % 2 === 0 ? 'd-post' : 'd-hover'), time.now())).toBe(true);
      time.advance(15_000);
    }
    expect(sent).toEqual([]);
    time.advance(DIGEST_WINDOW_MS - 50 * 15_000);
    expect(sent).toHaveLength(1);
    const frame = sent[0]?.[2];
    expect(frame).toMatchObject({
      event: 'coach.digest',
      workspaceId: 'w-coach',
      from: start,
      to: start + DIGEST_WINDOW_MS,
    });
    const items = frame?.event === 'coach.digest' ? frame.items : [];
    expect(items).toHaveLength(50);
    expect(items.every((i) => i.kind === 'view' && !('text' in i))).toBe(true);
    expect(turns).toEqual([start + DIGEST_WINDOW_MS]);
  });

  it('collapses a stay in one place to one line, and keeps what he wrote', () => {
    const { f, sent, time } = feed();
    for (let i = 0; i < 50; i += 1) {
      f.send({ ...viewNews('d-post'), heading: `Part ${i % 2}` }, time.now());
      time.advance(10_000);
    }
    f.send(
      {
        event: 'coach.event',
        kind: 'wrote',
        boardId: 'w-harbor',
        docId: 'd-post',
        text: 'Berths are free.',
      },
      time.now(),
    );
    time.advance(DIGEST_WINDOW_MS);
    const frame = sent[0]?.[2];
    expect(frame?.event === 'coach.digest' && frame.items).toEqual([
      expect.objectContaining({
        kind: 'view',
        docId: 'd-post',
        minutes: 15,
        headings: ['Part 0', 'Part 1'],
      }),
      expect.objectContaining({ kind: 'wrote', text: 'Berths are free.' }),
    ]);
  });

  it('sends at most one digest per 15 minutes, and none for a quiet window', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    time.advance(3 * DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    expect(time.pending()).toBe(0);
    const second = time.now();
    f.send(viewNews('d-hover'), second);
    time.advance(DIGEST_WINDOW_MS - 1);
    expect(sent).toHaveLength(1);
    time.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.[2]).toMatchObject({ from: second });
  });

  it('sends his answers and his setting at once, outside the window', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    f.send({ event: 'coach.preference', readiness: 'less' }, time.now());
    expect(sent.map(([, , fr]) => fr.event)).toEqual(['coach.preference']);
  });

  it('holds nothing for a session that is not there, and drops a window it left during', () => {
    const away = feed({ connected: false });
    expect(away.f.send(viewNews('d-post'), away.time.now())).toBe(false);
    expect(away.time.pending()).toBe(0);
    let connected = true;
    const time = fakeTime();
    const sent: SessionFrame[] = [];
    const f = new SessionFeed({
      now: time.now,
      schedule: time.schedule,
      countTurn: () => {},
      lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
      connected: () => connected,
      send: (_w, _a, fr) => {
        sent.push(fr);
        return 1;
      },
      eventsOn: () => 0,
    });
    f.send(viewNews('d-post'), time.now());
    connected = false;
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toEqual([]);
  });

  it('stop cancels a window still open', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    f.stop();
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toEqual([]);
  });
});
