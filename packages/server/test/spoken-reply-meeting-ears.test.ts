/**
 * `MeetingEars` on its own: a meeting's frames reach the listeners opened on
 * its doc and no other, and the notes composer's copy is held while a
 * question is out — dropped when the answer is placed, delivered in order
 * when it is not, and never held past the meeting's end or the cap.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_HELD_FRAMES, MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import type { EngineTurn } from '../src/transcribe.ts';

const turn = (text: string, final = true): EngineTurn => ({ turn: 0, text, final });

function opened(ears: MeetingEars, docId: string) {
  const heard: string[] = [];
  const session = ears.engine(docId).open({
    sampleRate: 16_000,
    detectSpeakers: false,
    onTurn: (t) => heard.push(t.text),
    onError: () => {},
  });
  return { heard, session };
}

describe('MeetingEars', () => {
  it('refuses to open on a doc with no meeting recording', async () => {
    const ears = new MeetingEars();
    await expect(opened(ears, 'd-a').session).rejects.toThrow('No meeting is recording');
  });

  it('lends the frames of the meeting on a doc to its listeners only, until closed', async () => {
    const ears = new MeetingEars();
    ears.started('d-a');
    ears.started('d-b');
    const a = opened(ears, 'd-a');
    const b = opened(ears, 'd-b');
    const session = await a.session;
    await b.session;
    ears.heard('d-a', turn('Harborlight opens in spring.'));
    expect(a.heard).toEqual(['Harborlight opens in spring.']);
    expect(b.heard).toEqual([]);
    await session.close();
    ears.heard('d-a', turn('Riverbend follows.'));
    expect(a.heard).toEqual(['Harborlight opens in spring.']);
  });

  it('delivers to the notes at once when no question is out', () => {
    const ears = new MeetingEars();
    ears.started('d-a');
    const got: string[] = [];
    ears.toNotes('d-a', () => got.push('one'));
    expect(got).toEqual(['one']);
  });

  it('drops what was held when the answer is placed, and delivers it in order when not', () => {
    const ears = new MeetingEars();
    ears.started('d-a');
    const got: string[] = [];
    ears.hold('d-a');
    ears.toNotes('d-a', () => got.push('answer'), { turn: 1, text: 'answer', final: true });
    ears.placed('d-a', 'The answer.');
    ears.toNotes('d-a', () => got.push('second answer'));
    ears.toNotes('d-a', () => got.push('more of it'));
    expect(got).toEqual([]);
    ears.release('d-a');
    expect(got).toEqual(['second answer', 'more of it']);
    ears.toNotes('d-a', () => got.push('after'));
    expect(got).toEqual(['second answer', 'more of it', 'after']);
  });

  it('lets go of everything held when the meeting ends, and holds nothing off a meeting', () => {
    const ears = new MeetingEars();
    const got: string[] = [];
    ears.hold('d-none');
    ears.toNotes('d-none', () => got.push('no meeting'));
    expect(got).toEqual(['no meeting']);
    ears.started('d-a');
    ears.hold('d-a');
    ears.toNotes('d-a', () => got.push('held'));
    ears.ended('d-a');
    expect(got).toEqual(['no meeting', 'held']);
    expect(ears.recording('d-a')).toBe(false);
  });

  it('stops holding past the cap, so an unanswered question cannot starve the notes', () => {
    const ears = new MeetingEars();
    ears.started('d-a');
    ears.hold('d-a');
    let got = 0;
    for (let i = 0; i <= MAX_HELD_FRAMES; i++) ears.toNotes('d-a', () => got++);
    expect(got).toBe(MAX_HELD_FRAMES + 1);
    ears.toNotes('d-a', () => got++);
    expect(got).toBe(MAX_HELD_FRAMES + 2);
  });
});
