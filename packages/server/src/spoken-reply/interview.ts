import type { prose } from '@claude-workspaces/core';
/**
 * Interview mode: on a plan, "interview me" asks about the plan's gaps one at
 * a time, most important first, and writes each spoken answer into the
 * section it is about.
 *
 * One per spoken-reply socket, held by its `SpokenAnswerer`, which asks this
 * first: while an interview runs, everything heard on the socket is an answer
 * or one of the commands in `interview-phrases.ts`, and nothing reaches the
 * board mic's router. Each reply is the next question, with `asking` set, so
 * the page listens for the answer.
 *
 * THE WRITE is `DocStore.applyBlockEdits` with `insert_under_heading` — the
 * verb the MCP block tools and the edit routes use — so it is an ordinary
 * edit of the live doc: threads keep their anchors, the browser sees it at
 * once and the bound file gets it at the next write-back. Nothing here
 * touches a file.
 *
 * THE DOC is the one the page says it is on, accepted only after
 * `InterviewDocs.onBoard` confirms it belongs to this socket's board — the
 * same membership check the router makes, because the page's context is
 * only clamped, never trusted, before it gets here.
 */
import { SPOKEN_MAX_WORDS } from '@claude-workspaces/core/spoken-reply';
import type { VoiceContext } from '../voice-prompt.ts';
import { capWords } from '../voice-status.ts';
import {
  type PlanGap,
  findPlanGaps,
  gapLine,
  questionFor,
  spokenHeading,
} from './interview-gaps.ts';
import type { GapOutcome, InterviewLog } from './interview-log.ts';
import { interviewCommand } from './interview-phrases.ts';
import { InterviewSlots, type SlotTransition } from './interview-state.ts';

/** The route word an interview's replies carry. */
export const INTERVIEW_ROUTE = 'interview';
/** The longest answer written, in characters. */
export const MAX_ANSWER_CHARS = 4000;

export type InterviewWrite = 'written' | 'gone' | 'failed';

/** The doc store as an interview needs it. */
export interface InterviewDocs {
  /** Whether `docId` is a doc on `workspaceId`. */
  onBoard(workspaceId: string, docId: string): boolean;
  outline(docId: string): readonly prose.OutlineEntry[] | null;
  /** Append `markdown` to the end of the section `headingId` heads. */
  writeUnder(docId: string, headingId: string, markdown: string): InterviewWrite;
}

export interface SpokenInterviewDeps {
  docs: InterviewDocs;
  log: InterviewLog;
  now?: () => number;
  newId?: () => string;
}

/** What an interview says back — the shape `SpokenAnswerer` returns. */
export interface InterviewReply {
  spoken: string;
  detail: string[];
  asking: boolean;
  route: string;
}

interface Running {
  id: string;
  docId: string;
  slots: InterviewSlots;
  /** When the current slot was asked. */
  askedAt: number;
  startedAt: number;
  filledMs: number;
}

/** A spoken answer as one markdown paragraph: a leading `#`, `-`, `>` or
 *  `1.` would otherwise make it a heading, a list or a quote. */
export function answerMarkdown(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_CHARS);
  return flat.replace(/^([#>*+-]|\d+[.)])/, '\\$1');
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

export class SpokenInterview {
  private run: Running | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly deps: SpokenInterviewDeps,
    private readonly workspaceId: string,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => `iv-${Date.now().toString(36)}`);
  }

  get active(): boolean {
    return this.run !== null;
  }

  /**
   * The reply to `transcript`, or null when it is not the interview's: no
   * interview is running and this is not "interview me". An empty
   * transcript is the page reporting a silence after the question.
   */
  answer(transcript: string, context: VoiceContext | undefined): InterviewReply | null {
    const cmd = interviewCommand(transcript);
    const run = this.run;
    if (!run) return cmd === 'start' ? this.begin(context) : null;
    const text = transcript.trim();
    if (!text) {
      return run.slots.silence() === 'offer-skip'
        ? this.question(run, 'Still there? Say skip to move on, or answer:')
        : this.question(run, 'I didn’t catch that.');
    }
    switch (cmd) {
      case 'start':
      case 'repeat':
        return this.question(run, cmd === 'start' ? 'We’re in the interview.' : '');
      case 'skip':
        return this.settle(run, 'skipped', 'Skipped.');
      case 'later':
        return this.settle(run, 'deferred', 'I’ll come back to that.');
      case 'enough':
        return this.settle(run, 'ended', 'Stopping here.');
      default:
        return this.write(run, text);
    }
  }

  private begin(context: VoiceContext | undefined): InterviewReply {
    const docId = context?.surface === 'doc' ? context.docId : undefined;
    if (!docId || !this.deps.docs.onBoard(this.workspaceId, docId)) {
      return this.say('Open a plan and say interview me there.');
    }
    const outline = this.deps.docs.outline(docId);
    if (!outline) return this.say('I can’t read this doc.');
    const gaps = findPlanGaps(outline);
    if (gaps.length === 0) return this.say('I found no gaps in this plan.');
    const at = this.now();
    const run: Running = {
      id: this.newId(),
      docId,
      slots: new InterviewSlots(gaps),
      askedAt: at,
      startedAt: at,
      filledMs: 0,
    };
    this.run = run;
    return {
      ...this.question(run, `I found ${plural(gaps.length, 'gap')}. First:`),
      detail: gaps.map((g, i) => `${i + 1}. ${gapLine(g)}`),
    };
  }

  private write(run: Running, text: string): InterviewReply {
    const markdown = answerMarkdown(text);
    let gap = this.slot(run);
    let res = this.deps.docs.writeUnder(run.docId, gap.headingId, markdown);
    if (res === 'gone') {
      // A reparse re-mints block ids; the same heading may still be there.
      const again = this.deps.docs
        .outline(run.docId)
        ?.find((b) => b.kind === 'heading' && b.text.trim() === gap.heading);
      if (again) {
        run.slots.rebind(again.id);
        gap = this.slot(run);
        res = this.deps.docs.writeUnder(run.docId, gap.headingId, markdown);
      }
    }
    if (res === 'failed') return this.question(run, 'I couldn’t write that.');
    if (res === 'gone')
      return this.settle(run, 'gone', `${spokenHeading(gap)} is gone from the doc.`);
    run.filledMs += this.now() - run.askedAt;
    return this.settle(run, 'placed', `Written under ${spokenHeading(gap)}.`, wordCount(text));
  }

  /** Record the current slot's outcome, settle it, and ask the next. */
  private settle(run: Running, how: SlotTransition, lead: string, words?: number): InterviewReply {
    this.recordGap(run, OUTCOME[how], words);
    const { next, again } = run.slots.settle(how);
    if (how === 'ended') return this.finish(run, lead);
    if (!next) return this.finish(run, `${lead} That was the last gap.`);
    run.askedAt = this.now();
    return this.question(run, again ? `${lead} It’s the only one left:` : `${lead} Next:`);
  }

  private finish(run: Running, lead: string): InterviewReply {
    this.run = null;
    const { slots } = run;
    this.deps.log.record({
      type: 'end',
      interview: run.id,
      docId: run.docId,
      gaps: slots.total,
      filled: slots.placed,
      skipped: slots.skipped,
      ms: this.now() - run.startedAt,
      ...(slots.placed > 0 ? { minutesPerFilled: run.filledMs / slots.placed / 60_000 } : {}),
      at: this.now(),
    });
    return {
      ...this.say(`${lead} ${slots.placed} of ${plural(slots.total, 'gap')} filled.`),
      detail: slots.unasked.map((g) => `Not asked: ${gapLine(g)}`),
    };
  }

  /** The slot being asked; a running interview always has one. */
  private slot(run: Running): PlanGap {
    const gap = run.slots.current;
    if (!gap) throw new Error('interview running with no slot');
    return gap;
  }

  private question(run: Running, lead: string): InterviewReply {
    const spoken = capWords(`${lead} ${questionFor(this.slot(run))}`.trim(), SPOKEN_MAX_WORDS);
    return {
      spoken,
      detail: ['Say skip, come back to that, or that’s enough.'],
      asking: true,
      route: INTERVIEW_ROUTE,
    };
  }

  private say(spoken: string): InterviewReply {
    return { spoken, detail: [], asking: false, route: INTERVIEW_ROUTE };
  }

  private recordGap(run: Running, outcome: GapOutcome, words?: number): void {
    const gap = this.slot(run);
    this.deps.log.record({
      type: 'gap',
      interview: run.id,
      docId: run.docId,
      section: gap.ordinal,
      kind: gap.kind,
      outcome,
      ms: this.now() - run.askedAt,
      ...(words !== undefined ? { words } : {}),
      at: this.now(),
    });
  }
}

/** The log's word for each transition. */
const OUTCOME: Record<SlotTransition, GapOutcome> = {
  placed: 'filled',
  skipped: 'skipped',
  deferred: 'deferred',
  gone: 'gone',
  ended: 'ended',
};
