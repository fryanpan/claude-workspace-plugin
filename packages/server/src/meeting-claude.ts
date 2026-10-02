/**
 * "Claude, …" said in a bot meeting: a one-line spoken answer into the call,
 * and the detail written into the meeting's notes.
 *
 * Two rules decide whether anything happens, and both fail closed:
 *
 *  - THE WAKE PHRASE opens the utterance: "Claude," or "Hey Claude," with a
 *    pause mark after it, then the request. The transcriber writes the pause
 *    as a comma, so "Claude's notes say…", "Claudia, …" and "Cloud, …" are
 *    not addressed to anyone, and neither is "Claude" said mid-sentence.
 *  - THE OWNER ASKS. A speaker is the owner only when Recall's participant
 *    email matches the server's owner email (`CW_OWNER_EMAIL`). A display
 *    name never counts: anyone in a call can rename themselves, and two
 *    people can share a name. No email on the participant, or no owner email
 *    configured, is silence.
 *
 * Claude never speaks unprompted, so a final turn that fails either rule
 * returns before anything is read, and nothing here runs on a timer.
 *
 * The answer comes from the board's own answerer (`spoken-reply/answer.ts`),
 * the one setups 1 to 4 use, so a meeting hears what the board mic would
 * say. Only its first sentence is said; the rest is the note. The note is
 * written before the voice is tried, so a voice that fails still leaves it.
 */
import type { RecallClient } from './recall.ts';
import { type SpokenAnswer, SpokenAnswerer, type SpokenBoard } from './spoken-reply/answer.ts';
import type { SpokenVoice } from './spoken-reply/tts.ts';
import type { VoiceActor } from './voice-action.ts';

/** A meeting participant, as far as this decision needs one. */
export interface MeetingSpeaker {
  name: string | null;
  email: string | null;
}

/** One settled utterance, and where an answer to it would go. */
export interface MeetingUtterance {
  docId: string;
  botId: string;
  speaker: MeetingSpeaker;
  text: string;
  /** Writes lines into this meeting's own notes section. */
  note(markdown: string): void;
}

export type MeetingClaudeVerdict =
  | 'not-addressed'
  | 'not-owner'
  /** An answer to this bot is still being said; this request is dropped. */
  | 'busy'
  | 'answered';

export interface MeetingClaudeDeps {
  /** The owner's email. Empty or null means nobody may ask. */
  ownerEmail: string | null;
  /** The answerer for the board holding this doc; null when none does. */
  answererFor(docId: string): SpokenAnswerer | null;
  /** Who the owner is to the board, for anything the answer changes. */
  actor(speaker: MeetingSpeaker): VoiceActor;
  /** Says text as MP3, which is the one format Recall plays. Null: notes only. */
  voice: SpokenVoice | null;
  /** Plays MP3 into the call (`RecallClient.outputAudio`). */
  play(botId: string, mp3: Uint8Array): Promise<void>;
  log?: (line: string) => void;
}

/** The pause mark the transcriber writes after a name being called. */
const WAKE = /^(?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\s*[,.!?:;–—-]+\s*(\S[\s\S]*)$/i;

/** The request after the wake phrase, or null when nobody called Claude. */
export function wakeRequest(text: string): string | null {
  const m = text.trim().match(WAKE);
  const ask = m?.[1]?.trim();
  return ask ? ask : null;
}

/** Whether this speaker is the owner. Fails closed: no email is no. */
export function isOwner(speaker: MeetingSpeaker, ownerEmail: string | null): boolean {
  const want = ownerEmail?.trim().toLowerCase();
  const have = speaker.email?.trim().toLowerCase();
  return Boolean(want) && want === have;
}

/** At most this many words are said aloud; a meeting is not listening to a brief. */
export const MEETING_SPOKEN_MAX_WORDS = 25;

/** The one line said into the call. */
export function spokenLine(a: SpokenAnswer): string {
  const first = a.points[0]?.say ?? a.spoken;
  const words = first.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= MEETING_SPOKEN_MAX_WORDS) return words.join(' ');
  return `${words.slice(0, MEETING_SPOKEN_MAX_WORDS).join(' ')}…`;
}

/** The note: the request, the whole answer, and its written detail. */
export function noteFor(request: string, a: SpokenAnswer, asker: string | null): string {
  const lines = [`- Claude, asked by ${asker ?? 'the owner'} “${request}”: ${a.spoken}`];
  for (const d of a.detail) lines.push(`  - ${d}`);
  return lines.join('\n');
}

export class MeetingClaude {
  /** Bots saying an answer now. A second request waits for none. */
  private readonly speaking = new Set<string>();
  /** One answerer per bot, so "which goal?" is answered in the same call. */
  private readonly answerers = new Map<string, SpokenAnswerer>();

  constructor(private readonly deps: MeetingClaudeDeps) {}

  /** Whether a bot should be created able to play audio. */
  get speaks(): boolean {
    return this.deps.voice !== null;
  }

  /** A settled utterance. Resolves once the answer is noted and said. */
  async heard(u: MeetingUtterance): Promise<MeetingClaudeVerdict> {
    const request = wakeRequest(u.text);
    if (request === null) return 'not-addressed';
    if (!isOwner(u.speaker, this.deps.ownerEmail)) return 'not-owner';
    if (this.speaking.has(u.botId)) return 'busy';
    this.speaking.add(u.botId);
    try {
      await this.answer(u, request);
    } catch (err) {
      this.deps.log?.(
        `[meeting-claude] ${u.docId}: ${err instanceof Error ? err.message : 'answer failed'}`,
      );
    } finally {
      this.speaking.delete(u.botId);
    }
    return 'answered';
  }

  /** The bot left: its pending question goes with it. */
  forget(botId: string): void {
    this.answerers.delete(botId);
    this.speaking.delete(botId);
  }

  private async answer(u: MeetingUtterance, request: string): Promise<void> {
    let answerer = this.answerers.get(u.botId);
    if (!answerer) {
      const made = this.deps.answererFor(u.docId);
      if (made) {
        answerer = made;
        this.answerers.set(u.botId, made);
      }
    }
    const a: SpokenAnswer = answerer
      ? await answerer.answer(request, this.deps.actor(u.speaker), undefined)
      : {
          spoken: 'This meeting is not on a board, so I have nothing to look up.',
          points: [{ say: 'This meeting is not on a board, so I have nothing to look up.' }],
          detail: [],
          asking: false,
          route: 'none',
        };
    if (!a.spoken) return;
    u.note(noteFor(request, a, u.speaker.name));
    const voice = this.deps.voice;
    if (!voice) return;
    const chunks: Uint8Array[] = [];
    await voice.speak(spokenLine(a), (b) => chunks.push(b), new AbortController().signal);
    const mp3 = Buffer.concat(chunks);
    if (mp3.length === 0) return;
    await this.deps.play(u.botId, new Uint8Array(mp3));
  }
}

/**
 * The server's one meeting Claude, or null when it is off: not switched on
 * (`CW_MEETING_CLAUDE=1`), no owner email to recognise the owner by, or no
 * Recall client to play through.
 */
export function createMeetingClaude(o: {
  enabled: boolean;
  ownerEmail: string | undefined;
  client: RecallClient | null;
  voice: SpokenVoice | null;
  /** Read at answer time: the board router is built after the relay. */
  board: () => SpokenBoard;
  boardOf: (docId: string) => string | undefined;
  ownerId: () => string;
}): MeetingClaude | null {
  const ownerEmail = o.ownerEmail?.trim() ?? '';
  const client = o.client;
  if (!o.enabled || !ownerEmail || !client) return null;
  return new MeetingClaude({
    ownerEmail,
    answererFor: (docId) => {
      const workspaceId = o.boardOf(docId);
      return workspaceId ? new SpokenAnswerer(o.board(), workspaceId) : null;
    },
    actor: (speaker) => ({ id: o.ownerId(), name: speaker.name ?? 'Owner', kind: 'known' }),
    voice: o.voice,
    play: (botId, mp3) => client.outputAudio(botId, mp3),
    log: (line) => console.error(line),
  });
}
