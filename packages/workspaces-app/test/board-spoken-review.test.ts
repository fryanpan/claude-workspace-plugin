import type { SpokenDecide } from '@claude-workspaces/core/spoken-reply';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewReplyRequest } from '../src/board/board-review-model.ts';
import { TAP_MS } from '../src/board/spoken-reply-client.ts';
import { writeSpokenDecision } from '../src/board/spoken-review-decide.ts';
import { spokenHarness as harness } from './support/spoken-reply-harness.ts';

/**
 * The page's half of the voice review queue: a `decide` on a reply is written
 * through the answer card's own routes, and the result goes back as `decided`.
 */

const AUTHOR = { id: 'u-1', name: 'Alice', kind: 'known' };
const TICKET = { kind: 'task-review', taskId: 't 1', reviewItemId: 'r-1' } as const;
const THREAD = { kind: 'doc-thread', docId: 'd-1', threadId: 'th-1', commentId: 'c-1' } as const;

function recorder(ok = true, data: Record<string, unknown> | null = {}) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  return {
    calls,
    send: async (path: string, method: string, body: unknown) => {
      calls.push({ path, method, body });
      return { ok, data };
    },
  };
}

describe('writeSpokenDecision', () => {
  it('writes a ticket answer where the answer card writes it, with the person as author', async () => {
    const r = recorder();
    const d: SpokenDecide = {
      id: 'd1',
      action: 'record',
      target: TICKET,
      text: 'Hold',
      optionId: 'o-hold',
    };
    expect(await writeSpokenDecision(d, { workspaceId: 'w-1', author: AUTHOR, send: r.send })).toBe(
      true,
    );
    const card = reviewReplyRequest(
      {
        key: 'k',
        kind: 'task-review',
        title: '',
        ask: '',
        why: '',
        since: 0,
        thread: { ...TICKET, workspaceId: 'w-1' } as never,
      },
      'Hold',
      'o-hold',
    );
    expect(r.calls).toEqual([
      { path: card?.path, method: 'POST', body: { ...card?.body, author: AUTHOR } },
    ]);
    expect(r.calls[0]?.path).toBe('/workspaces/w-1/tasks/t%201/review-items/r-1/answer');
  });

  it('takes back a ticket answer and a thread answer at their undo routes', async () => {
    const r = recorder();
    const deps = { workspaceId: 'w-1', author: AUTHOR, send: r.send };
    await writeSpokenDecision({ id: 'd2', action: 'undo', target: TICKET }, deps);
    await writeSpokenDecision({ id: 'd3', action: 'undo', target: THREAD }, deps);
    expect(r.calls).toEqual([
      {
        path: '/workspaces/w-1/tasks/t%201/review-items/r-1/answer/undo',
        method: 'POST',
        body: { author: AUTHOR },
      },
      {
        path: '/workspaces/w-1/docs/d-1/threads/th-1/answer/undo',
        method: 'POST',
        body: { commentId: 'c-1', author: AUTHOR },
      },
    ]);
  });

  it('reports a refused write, and an answer the server took as a question, as not landed', async () => {
    const d: SpokenDecide = { id: 'd4', action: 'record', target: THREAD, text: 'Why?' };
    const deps = { workspaceId: 'w-1', author: AUTHOR };
    expect(await writeSpokenDecision(d, { ...deps, send: recorder(false).send })).toBe(false);
    expect(
      await writeSpokenDecision(d, { ...deps, send: recorder(true, { asked: true }).send }),
    ).toBe(false);
  });
});

describe('a reply carrying a decision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('is written, and its result is sent back as decided', async () => {
    const written: SpokenDecide[] = [];
    const h = harness({
      onDecide: async (d) => {
        written.push(d);
        return d.id === 'd1';
      },
    });
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    const decide: SpokenDecide = { id: 'd1', action: 'record', target: TICKET, text: 'Hold' };
    h.socket.reply({
      type: 'reply',
      spoken: 'Recorded.',
      detail: [],
      asking: false,
      route: 'review-queue',
      decide,
    });
    h.socket.reply({
      type: 'reply',
      spoken: 'Taken back.',
      detail: [],
      asking: true,
      route: 'review-queue',
      decide: { id: 'd2', action: 'undo', target: TICKET },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(written.map((d) => d.id)).toEqual(['d1', 'd2']);
    const decided = h.socket.json().filter((m) => m.type === 'decided');
    expect(decided).toEqual([
      { type: 'decided', id: 'd1', ok: true },
      { type: 'decided', id: 'd2', ok: false },
    ]);
  });

  it('writes nothing for a reply without one', async () => {
    const written: SpokenDecide[] = [];
    const h = harness({
      onDecide: async (d) => {
        written.push(d);
        return true;
      },
    });
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({
      type: 'reply',
      spoken: 'Recording: Hold. OK?',
      detail: [],
      asking: true,
      choices: ['Yes', 'No'],
      route: 'review-queue',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([]);
    expect(h.socket.json().some((m) => m.type === 'decided')).toBe(false);
  });
});
