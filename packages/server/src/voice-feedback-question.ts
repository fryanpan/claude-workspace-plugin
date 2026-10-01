import type { VoiceAskFrame, VoiceServerMessage } from '@claude-workspaces/core';
/**
 * A voice session's one open question: put to the page, said aloud, and
 * answered — by a tap on a choice, or by the next words said.
 *
 * Which notes get a question, and how a short spoken answer is matched, is
 * `voice-feedback-ask.ts`. This is the session's half: at most one question
 * is open, it is about the note being talked about, and an answer edits that
 * note in place — its element (now fixed, as a tap would fix it) or its words
 * — and sends the same key again, so the page edits the thread it already
 * wrote rather than writing another. The question comes down when it is
 * answered, skipped, or when its note settles because the talk moved on.
 *
 * The voice is the spoken reply's (setup 1 is Soniox), passed in by the
 * server; with none the page shows the question as text, choices and all.
 */
import { SPOKEN_OUTPUT_RATE } from '@claude-workspaces/core/spoken-reply';
import {
  type AskProposal,
  type AskVerdict,
  type PendingAsk,
  answerFromWords,
  decideAsk,
} from './voice-feedback-ask.ts';
import type { LiveComment, Session } from './voice-feedback-session.ts';
import { type TidyInput, parseTidyReply } from './voice-feedback-tidy.ts';

/** The slice of `SpokenVoice` (`spoken-reply/tts.ts`) a question needs. */
export interface QuestionVoice {
  speak(text: string, onAudio: (pcm: Uint8Array) => void, signal: AbortSignal): Promise<void>;
}

export interface VoiceQuestionDeps {
  voice: QuestionVoice | null;
  send(s: Session, msg: VoiceServerMessage): void;
  /** Send a note's frame again, so the page edits its thread. */
  emit(s: Session, c: LiveComment): void;
  log?: (line: string) => void;
}

export class VoiceQuestions {
  constructor(private readonly deps: VoiceQuestionDeps) {}

  /** The question waiting on `s`, as the tidy prompt shows it. */
  asked(s: Session): { question: string; choices: string[] } | undefined {
    return s.ask
      ? { question: s.ask.question, choices: s.ask.choices.map((c) => c.label) }
      : undefined;
  }

  /** Ask about `note` if the rule lets the model's proposal stand. */
  offer(s: Session, note: LiveComment, proposal: AskProposal | undefined, words: string): void {
    if (s.ask || s.closed || note !== s.open) return;
    const verdict = decideAsk(proposal, {
      key: note.key,
      fixed: note.fixed,
      asked: note.asked === true,
      words,
      targets: s.targets,
    });
    if (!verdict.ask) return;
    note.asked = true;
    s.ask = verdict.ask;
    s.log.write(`- Asked about ${note.key}: ${verdict.ask.question}\n`);
    this.deps.send(s, this.frame(verdict.ask));
    void this.say(s, verdict.ask.question);
  }

  private frame(a: PendingAsk): VoiceAskFrame {
    return {
      type: 'ask',
      key: a.key,
      question: a.question,
      choices: a.choices.map((c) => c.label),
      about: a.about,
    };
  }

  private async say(s: Session, question: string): Promise<void> {
    const { voice } = this.deps;
    if (!voice) return;
    const ctl = new AbortController();
    s.speaking?.abort();
    s.speaking = ctl;
    this.deps.send(s, { type: 'ask-audio', on: true, sampleRate: SPOKEN_OUTPUT_RATE });
    try {
      const audio = (pcm: Uint8Array) => {
        try {
          s.ws.send(pcm);
        } catch {
          // A socket that closed mid-send has its close handler coming.
        }
      };
      await voice.speak(question, audio, ctl.signal);
    } catch (err) {
      this.deps.log?.(`[voice-feedback] the question could not be said: ${String(err)}`);
    } finally {
      if (s.speaking === ctl) s.speaking = null;
      this.deps.send(s, { type: 'ask-audio', on: false });
    }
  }

  /** Take the question down, whatever became of it. */
  clear(s: Session): void {
    const a = s.ask;
    if (!a) return;
    s.ask = null;
    s.speaking?.abort();
    s.speaking = null;
    if (!s.closed) this.deps.send(s, { ...this.frame(a), question: '', choices: [] });
  }

  /** A choice applied to its note: the same note, edited, sent again. */
  answer(s: Session, choice: number | null): void {
    const a = s.ask;
    if (!a) return;
    const c = s.comments.get(a.key);
    const pick = choice === null ? undefined : a.choices[choice];
    this.clear(s);
    if (!c || !pick) {
      s.log.write(`- ${a.key} kept as it was\n`);
      return;
    }
    if (a.about === 'anchor' && pick.element !== undefined) {
      c.target = pick.element;
      c.fixed = true;
    } else if (pick.text) {
      c.text = pick.text;
      c.clarified = pick.label;
    }
    s.log.write(`- ${a.key} answered: ${pick.label}\n`);
    this.deps.emit(s, c);
  }

  /** Words said while a question waits. True when they were plainly its
   *  answer and are used up; false sends them on to the tidier, which is
   *  shown the question beside them. */
  heard(s: Session, words: string): boolean {
    if (!s.ask) return false;
    const picked = answerFromWords(s.ask, words);
    if (picked === null) return false;
    this.answer(s, picked === 'skip' ? null : picked);
    return true;
  }
}

/**
 * The decision the relay makes on one tick's reply, for a note that is new:
 * its last comment's proposal through the rule. What the sample-notes eval
 * (`scripts/voice-ask-eval.ts`) scores, so it scores the code that ships.
 */
export function askVerdictFor(input: TidyInput, reply: string): AskVerdict {
  const last = parseTidyReply(reply, input)?.at(-1);
  if (!last) return { ask: null, why: 'no comment' };
  return decideAsk(last.ask, {
    key: 'v1',
    fixed: input.pinned !== undefined,
    asked: false,
    words: input.words,
    targets: input.targets,
  });
}
