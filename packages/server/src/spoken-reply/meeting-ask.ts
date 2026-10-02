/**
 * "Claude, …" said in a meeting recorded from the page's own microphone (or
 * microphone plus Mac audio): the same wake phrase and owner rule a Recall
 * bot meeting uses (`meeting-claude.ts`), answered through the page's
 * spoken-reply socket rather than into a call, with the detail written into
 * the meeting's notes.
 *
 * WHO ASKED. A bot meeting knows each speaker's email; a mic meeting knows
 * only the page. So the speaker is the person signed in on the page that
 * opened the socket, and only when the socket's own person proof — the
 * Cloudflare Access email or the signed session cookie, never a display
 * name, a body's claim, a widget token or an agent token — resolves to an
 * owner id (`isOwnerActor({ id })`, the check the grant door makes). That is
 * decided once, at the upgrade (`routes/upgrade-stream.ts`), and arrives
 * here as `owner`.
 *
 * WHOSE WORDS. A Mac-audio meeting also carries everybody dialled in, on the
 * `system` stream. Those words can never form a request: `own` holds only
 * what the page's microphone heard, and the wake phrase is looked for there.
 *
 * Fails closed like the bot path: no wake phrase, or not the owner, and
 * nothing is said or written.
 *
 * IN A PLANNING MEETING, "Claude, any questions?" is the planning voice's.
 * Asking the meeting's own assistant for its questions is asking for the
 * plan's open ones, so it goes to the interview as an invitation
 * (`SpokenAnswerer.invite`), never to the board router, which answered
 * Bryan's with a board status brief. Any other "Claude, …" still goes to the
 * router, and a discussion meeting is unchanged.
 */
import { noteFor, spokenLine, wakeRequest } from '../meeting-claude.ts';
import type { TranscriptionEngine } from '../transcribe.ts';
import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import type { SpokenAnswer, SpokenAnswerer } from './answer.ts';
import { asksForQuestions } from './interview-phrases.ts';

/** A meeting recording on a doc, as a spoken-reply socket may hear it. */
export interface MeetingRoom {
  /** The meeting's transcript, as a listener (`MeetingEars.engine`). */
  engine: TranscriptionEngine;
  /** A planning meeting: the planning voice asks at its pauses. */
  plan: boolean;
  /** Writes lines into this meeting's own notes section. */
  note(markdown: string): void;
}

/** One pause's worth of a meeting, as the answer needs it. */
export interface MeetingTurn {
  room: MeetingRoom;
  /** The socket's person proof names the owner. */
  owner: boolean;
  /** What the page's own microphone heard this turn. */
  own: string;
}

/** A wake phrase opening the turn or any sentence in it. */
const SENTENCE_WAKE = /(?:^|[.!?]\s+)((?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\s*[,.!?:;–—-])/gi;

/** The request after the first wake phrase that opens a sentence, or null. */
export function wakeRequestIn(text: string): string | null {
  for (const m of text.matchAll(SENTENCE_WAKE)) {
    const at = (m.index ?? 0) + m[0].length - (m[1]?.length ?? 0);
    const ask = wakeRequest(text.slice(at));
    if (ask !== null) return ask;
  }
  return null;
}

const SILENT: SpokenAnswer = {
  spoken: '',
  points: [],
  detail: [],
  asking: false,
  route: 'none',
};

/**
 * The answer to one pause of a meeting: Claude's, when the owner called it
 * on the page's microphone; else the planning voice's, in a plan; else
 * nothing.
 */
export async function meetingAnswer(
  answerer: SpokenAnswerer,
  heard: string,
  actor: VoiceActor,
  context: VoiceContext | undefined,
  turn: MeetingTurn,
): Promise<SpokenAnswer> {
  const request = turn.owner ? wakeRequestIn(turn.own) : null;
  if (request !== null && turn.room.plan && asksForQuestions(request)) {
    return answerer.invite(heard, actor, context);
  }
  if (request !== null) {
    // No `navigate`: following it would take the page off the meeting it
    // is recording.
    const { navigate: _, ...a } = await answerer.ask(request, actor, context);
    if (!a.spoken) return SILENT;
    turn.room.note(noteFor(request, a, actor.name));
    const line = spokenLine(a);
    return { ...a, spoken: line, points: [{ say: line }], asking: false };
  }
  return turn.room.plan ? answerer.answer(heard, actor, context, true) : SILENT;
}
