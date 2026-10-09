/**
 * Which broadcasts stale `/`, and that a burst costs one frame. The filter
 * reads event names only; `landing-live-stream.test.ts` drives the real
 * routes end to end.
 */
import { describe, expect, it } from 'bun:test';
import { LANDING_CHANNEL, createLandingChanges, stalesLanding } from '../src/landing-changes.ts';
import { waitFor } from './wait-for.ts';

describe('stalesLanding', () => {
  it('counts board work and asks', () => {
    for (const e of [
      'task.created',
      'workspace.goals_changed',
      'review_item.added',
      'decision.answered',
    ]) {
      expect(stalesLanding('ws~w-1', e)).toBe(true);
    }
    expect(stalesLanding('ws~w-1', 'thread.created')).toBe(true);
    expect(stalesLanding('d-riverbend', 'thread.replied')).toBe(true);
  });

  it('skips presence, receipts, doc traffic and its own channel', () => {
    for (const e of ['agent.heartbeat', 'agent.attached', 'agent.listening', 'comment.delivered']) {
      expect(stalesLanding('ws~w-1', e)).toBe(false);
    }
    expect(stalesLanding('d-riverbend', 'suggestion.created')).toBe(false);
    expect(stalesLanding(LANDING_CHANNEL, 'thread.created')).toBe(false);
  });
});

describe('createLandingChanges', () => {
  it('sends one frame for a burst, and another for the next burst', async () => {
    let sent = 0;
    const changes = createLandingChanges({ emit: () => (sent += 1), coalesceMs: 5 });
    for (let i = 0; i < 10; i += 1) changes.observe('ws~w-1', 'task.created');
    changes.observe('ws~w-1', 'agent.heartbeat');
    await waitFor(() => sent === 1, { describe: 'the first frame' });
    changes.notify();
    await waitFor(() => sent === 2, { describe: 'the second frame' });
    changes.dispose();
  });
});
