/**
 * The foot a spoken comment carries on the review doc's thread card: its
 * clip, the words as heard, and Undo — the widget card's foot (`voice-ui.ts`)
 * on the page's own card, so a voice note is an ordinary comment with three
 * more controls rather than a second kind of card.
 *
 * Undo resolves the thread and Redo reopens it: the comment is never deleted,
 * only put away, and the thread's own Resolve says the same thing in the
 * same place.
 */
import { type VoiceNote, clipLength } from '@claude-workspaces/core';

export interface VoiceFootActions {
  resolve: () => void;
  reopen: () => void;
}

/** One clip at a time across every card on the page. */
let playing: HTMLAudioElement | null = null;

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

export function voiceFoot(
  note: VoiceNote,
  resolved: boolean,
  on: VoiceFootActions,
  canWrite: boolean,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'voice-note';
  const raw = document.createElement('div');
  raw.className = 'voice-raw';
  raw.hidden = true;
  // Plain text: the words are whatever the transcriber heard.
  raw.textContent = `“${note.raw}”`;
  const foot = document.createElement('div');
  foot.className = 'voice-foot';
  const play = button(`▶ ${clipLength(note.clip)}`, 'voice-play');
  play.setAttribute('aria-label', 'Play the recording');
  play.addEventListener('click', () => {
    playing?.pause();
    playing = new Audio(note.clip);
    void playing.play().catch(() => {});
  });
  const words = button('Raw words', 'voice-rawbtn');
  words.setAttribute('aria-expanded', 'false');
  words.addEventListener('click', () => {
    raw.hidden = !raw.hidden;
    words.setAttribute('aria-expanded', String(!raw.hidden));
  });
  const undo = button(resolved ? 'Redo' : 'Undo', 'voice-undo');
  undo.addEventListener('click', () => (resolved ? on.reopen() : on.resolve()));
  if (!canWrite) {
    undo.disabled = true;
    undo.setAttribute('aria-disabled', 'true');
  }
  foot.append(play, words, undo);
  wrap.append(raw, foot);
  return wrap;
}
