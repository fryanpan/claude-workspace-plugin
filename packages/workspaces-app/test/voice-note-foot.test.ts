import type { Thread, User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * A spoken comment on the review doc is an ordinary thread card with the
 * voice note's foot (doc/voice-note-foot.ts): its clip, the words as heard,
 * and Undo. Driven through the panel that renders every doc card, so what is
 * asserted is the card a reader sees.
 */

const bryan: User = { id: 'u1', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-2.wav#t=10,17.4';

function voiceThread(status: Thread['status'], voice = true): Thread {
  return {
    id: 't1',
    status,
    anchor: {
      kind: 'element',
      fingerprint: undefined as never,
      snippet: { text: 'the rollout paragraph' },
    },
    comments: [
      {
        id: 'c1',
        author: bryan,
        text: 'Give this a date.',
        ts: 1_700_000_000_000,
        ...(voice ? { voice: { clip: CLIP, raw: 'um this one needs a date' } } : {}),
      },
    ],
    commentCount: 1,
    lastActivity: 1_700_000_000_000,
    createdBy: bryan,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function render(t: Thread, canWrite = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const calls = { resolve: [] as string[], reopen: [] as string[] };
  const panel = new ThreadPanel({
    container,
    currentUser: bryan,
    canWrite,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: (id) => calls.resolve.push(id),
    onReopen: (id) => calls.reopen.push(id),
    onReanchor: () => {},
  });
  // The drawer's All tab, so a resolved card is on screen as it is in the margin.
  panel.setTab('all');
  panel.setThreads([t]);
  const card = container.querySelector<HTMLElement>('.thread[data-thread-id="t1"]');
  if (!card) throw new Error('no card');
  // The folded face is what a reader meets first.
  const face = card.querySelector('.slot-a .face-summary') as HTMLElement;
  return { card, face, calls };
}

const button = (root: Element, cls: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`.${cls}`);
  if (!b) throw new Error(`no .${cls}`);
  return b;
};

describe('a voice comment on the review doc', () => {
  it('carries its clip length, its raw words behind a toggle, and Undo', () => {
    const { face, calls } = render(voiceThread('open'));
    expect(button(face, 'voice-play').textContent).toBe('▶ 0:07');
    const raw = face.querySelector('.voice-raw') as HTMLElement;
    expect(raw.hidden).toBe(true);
    button(face, 'voice-rawbtn').click();
    expect(raw.hidden).toBe(false);
    expect(raw.textContent).toBe('“um this one needs a date”');
    const undo = button(face, 'voice-undo');
    expect(undo.textContent).toBe('Undo');
    undo.click();
    expect(calls.resolve).toEqual(['t1']);
  });

  it('once undone, offers Redo, which reopens it', () => {
    const { face, calls } = render(voiceThread('resolved'));
    const redo = button(face, 'voice-undo');
    expect(redo.textContent).toBe('Redo');
    redo.click();
    expect(calls.reopen).toEqual(['t1']);
    expect(calls.resolve).toEqual([]);
  });

  it('is not offered on a typed comment', () => {
    const { card } = render(voiceThread('open', false));
    expect(card.querySelector('.voice-foot')).toBeNull();
  });

  it('cannot be undone by a reader who cannot write', () => {
    const { face, calls } = render(voiceThread('open'), false);
    const undo = button(face, 'voice-undo');
    expect(undo.disabled).toBe(true);
    undo.click();
    expect(calls.resolve).toEqual([]);
  });
});
