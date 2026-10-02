/**
 * The planning voice's ears in a planning meeting: the meeting's own
 * transcript, lent to a spoken-reply socket on the same doc.
 *
 * A planning meeting already has a microphone and a listener — the meeting
 * relay's (`meeting-protocol.ts`). A second microphone and a second listener
 * for the planning voice would pay twice for the same words and hear the room
 * twice. So the relay hands every frame it hears to `heard`, and a socket
 * whose `start` says `ears: 'meeting'` opens `engine(docId)` in place of its
 * own listener. That socket then runs the ordinary planning-voice turn: the
 * pause gate, the interview, the voice (`session.ts`).
 *
 * THE ANSWER GOES TO THE PLAN, NOT THE NOTES TOO. While the planning voice
 * has a question out, what the meeting hears next is the answer, and the
 * interview writes it under its heading. So from the question on, the frames
 * meant for the notes composer are held here (`hold`) rather than delivered.
 * When the answer is written they are dropped (`placed`): the plan has them.
 * When it is not — a bare "yes", "I don't know yet", the socket going — they
 * are delivered as they were (`release`), late but whole and in order. A
 * meeting that ends delivers anything still held before the notes flush.
 *
 * The same ears serve "Claude, …" in any meeting the page records
 * (`meeting-ask.ts`), whose detail `note` writes into the meeting's notes.
 *
 * Nothing here is a vendor, a timer or a file: a map of listeners and a map
 * of held deliveries, keyed by doc id.
 */
import type { EngineTurn, TranscriptionEngine } from '../transcribe.ts';

/** Frames held for one answer before they are let go anyway: about ten
 *  minutes of a busy room, so a question nobody answers cannot starve the
 *  notes for the rest of the meeting. */
export const MAX_HELD_FRAMES = 2_000;

interface Room {
  /** Deliveries to the notes composer, held while a question is out. */
  held: Array<() => void> | null;
  /** Writes lines into the meeting's own notes section. */
  note: (markdown: string) => void;
}

export class MeetingEars {
  private readonly listeners = new Map<string, Set<(turn: EngineTurn) => void>>();
  private readonly rooms = new Map<string, Room>();

  /** A meeting on `docId` went live; `note` writes into its notes. */
  started(docId: string, note: (markdown: string) => void = () => {}): void {
    if (!this.rooms.has(docId)) this.rooms.set(docId, { held: null, note });
  }

  /** Lines for the notes of the meeting on `docId` ("Claude, …"'s detail). */
  note(docId: string, markdown: string): void {
    this.rooms.get(docId)?.note(markdown);
  }

  /** The meeting on `docId` ended: whatever was held reaches the notes. */
  ended(docId: string): void {
    this.release(docId);
    this.rooms.delete(docId);
  }

  recording(docId: string): boolean {
    return this.rooms.has(docId);
  }

  /** A frame the meeting on `docId` heard. */
  heard(docId: string, turn: EngineTurn): void {
    for (const fn of this.listeners.get(docId) ?? []) fn(turn);
  }

  /** Hand the notes composer a frame, now or once the answer is settled. */
  toNotes(docId: string, deliver: () => void): void {
    const held = this.rooms.get(docId)?.held;
    if (!held) {
      deliver();
      return;
    }
    held.push(deliver);
    if (held.length > MAX_HELD_FRAMES) this.release(docId);
  }

  /** A question is out: what is heard next may be its answer. */
  hold(docId: string): void {
    const room = this.rooms.get(docId);
    if (room && !room.held) room.held = [];
  }

  /** The answer was written into the plan: the notes never get it. */
  placed(docId: string): void {
    const room = this.rooms.get(docId);
    if (room?.held) room.held = [];
  }

  /** No answer to write: everything held goes to the notes, in order. */
  release(docId: string): void {
    const room = this.rooms.get(docId);
    const held = room?.held;
    if (!room || !held) return;
    room.held = null;
    for (const deliver of held) deliver();
  }

  /** The meeting's transcript on `docId`, as a listener a spoken-reply
   *  session can open. Opening fails when no meeting is recording there. */
  engine(docId: string): TranscriptionEngine {
    return {
      name: 'meeting',
      open: async (opts) => {
        if (!this.recording(docId)) throw new Error('No meeting is recording on this doc.');
        const fn = (turn: EngineTurn): void => opts.onTurn(turn);
        let set = this.listeners.get(docId);
        if (!set) {
          set = new Set();
          this.listeners.set(docId, set);
        }
        set.add(fn);
        return {
          // The meeting's own socket carries the audio.
          send: () => {},
          close: async () => {
            const now = this.listeners.get(docId);
            now?.delete(fn);
            if (now?.size === 0) this.listeners.delete(docId);
          },
        };
      },
    };
  }
}
