/**
 * Workflow B's stream: active time counted from the pages' pings, a hidden
 * tab or a long silence counting nothing, and the free trigger firing on a
 * switch after a long stretch or a long stay on one thing.
 */
import { describe, expect, it } from 'bun:test';
import type { Event } from '../src/activity.ts';
import { CoachStream, STAY_MS, SWITCH_AFTER_MS } from '../src/coach/stream.ts';
import { DRIFTING_DAY, WS, ZONE, at, label } from './coach-fixtures.ts';

const ping = (s: CoachStream, when: number, docId: string, visible = true) =>
  s.here({ at: when, workspaceId: WS, docId, visible });

describe('active time', () => {
  it('counts pings under three minutes apart, and not a gap or a hidden tab', () => {
    const s = new CoachStream();
    ping(s, at(9), 'd-post');
    ping(s, at(9, 2), 'd-post');
    ping(s, at(9, 4), 'd-post');
    ping(s, at(9, 14), 'd-post'); // ten idle minutes
    ping(s, at(9, 16), 'd-post');
    ping(s, at(9, 17), 'd-post', false);
    ping(s, at(9, 18), 'd-post');
    expect(s.current?.activeMs).toBe(7 * 60_000);
  });
});

describe('the trigger', () => {
  it('fires on a long stay, and again a stay later', () => {
    const s = new CoachStream();
    const fired: number[] = [];
    for (let m = 0; m <= 45; m += 1) {
      if (ping(s, at(9, m), 'd-hover') === 'stayed') fired.push(m);
    }
    expect(fired).toEqual([STAY_MS / 60_000, (2 * STAY_MS) / 60_000]);
  });

  it('fires on a switch after a long stretch, not after a glance', () => {
    const s = new CoachStream();
    for (let m = 0; m <= SWITCH_AFTER_MS / 60_000; m += 2) ping(s, at(9, m), 'd-post');
    expect(ping(s, at(9, 12), 'd-hover')).toBe('switched');
    ping(s, at(9, 13), 'd-hover');
    expect(ping(s, at(9, 14), 'd-tokens')).toBeNull();
  });

  it('takes owner rows as signals and leaves agents’ and reading sessions out', () => {
    const s = new CoachStream();
    const row = (type: string, isOwner: boolean) =>
      ({
        ts: new Date(at(9)).toISOString(),
        type,
        isOwner,
        doc: { docId: 'd-post' },
        payload: {},
      }) as unknown as Event;
    s.activity(row('edit_session', false), at(9), () => WS);
    expect(s.current).toBeUndefined();
    s.activity(row('read_session', true), at(9), () => WS);
    expect(s.current).toBeUndefined();
    s.activity(row('edit_session', true), at(9), () => WS);
    expect(s.current?.docId).toBe('d-post');
  });
});

describe('the last hour, as the prompt reads it', () => {
  it('names where he is, where he was, whether he wrote there, and what he did, with no agent rows', () => {
    const s = new CoachStream();
    for (const sig of DRIFTING_DAY) {
      if (sig.at > at(10, 50)) break;
      if ('here' in sig) s.here({ ...sig.here, at: sig.at });
      else s.activity(sig.row, sig.at, () => WS);
    }
    const seen = s.lines(at(10, 50), ZONE, label, () => 'Harborlight');
    expect(seen.now).toBe(
      'Since 10:44 on "Board colour tokens" on board "Harborlight": 6 min active, reading the part headed "Greys", 43% of the way down; he wrote nothing there.',
    );
    expect(seen.where).toContain(
      '09:41–10:31 "Button hover states mock" on board "Harborlight": 50 min active; he commented there at 10:12',
    );
    expect(seen.where.at(-1)).toBe(
      '10:31–10:44 "Message from a Riverbend partner, waiting on your answer" on board "Riverbend": 13 min active; he wrote nothing there',
    );
    expect(seen.did.join('\n')).toContain(
      'commented: "Try a softer shadow on hover, and a 2px lift."',
    );
    expect(seen.did.join('\n')).not.toContain('booking');
  });
});
