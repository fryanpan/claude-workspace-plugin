import type { prose } from '@claude-workspaces/core';
/**
 * The planning voice: with voice on in a plan, the person just talks, and at
 * each pause the agent asks about the plan's next open question, most
 * important first, and writes each spoken answer into the section it is
 * about. "Interview me" still starts it by name; it no longer has to.
 *
 * One per spoken-reply socket, held by its `SpokenAnswerer`, which asks this
 * first. On a doc on the socket's board every turn is this module's: the
 * first pause begins the run, and the socket's session ends each turn only
 * at a confirmed pause (`pause-gate.ts`), so a question never cuts into a
 * sentence. After each answer it does one of three things, logged as
 * `after-answer`:
 *
 *  - `edit`: the answer is written under its heading, and the next question
 *    is asked at once, since the person has just paused;
 *  - `follow-up`: a bare "yes" or "maybe" says nothing yet, so it asks once
 *    for more;
 *  - `quiet`: "I don't know yet", or a second bare answer: it says nothing,
 *    puts the question back in the queue, and asks its next one at the next
 *    pause.
 *
 * WHILE IT ASKS, its cursor is on the words it means — the open question as
 * written, or the heading — in every open view of the doc
 * (`InterviewDocs.focus`, the doc's presence; `doc/agent-focus.ts` scrolls
 * each page there and highlights them).
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
import type { AfterAnswer, GapOutcome, InterviewLog } from './interview-log.ts';
import { bareAnswer, interviewCommand } from './interview-phrases.ts';
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
  /** Put the agent's cursor on `quote` in block `blockId` in every open view
   *  of the doc, or take it off (null). */
  focus(docId: string, at: { blockId: string; quote: string } | null): void;
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
  /** The current slot has had its one follow-up. */
  followedUp: boolean;
  /** The last answer settled nothing: the next question waits for a pause. */
  waiting: boolean;
}

function docOf(context: VoiceContext | undefined): string | undefined {
  return context?.surface === 'doc' ? context.docId : undefined;
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
  /** Docs this socket's run finished or was stopped on: a run begins there
   *  again only when asked by name. */
  private readonly over = new Set<string>();
  /** The doc the agent's cursor is on. */
  private focused: string | null = null;
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

  /** Whether what is said in `context` is the planning voice's to hear. */
  listensOn(context: VoiceContext | undefined): boolean {
    const docId = docOf(context);
    return docId !== undefined && this.deps.docs.onBoard(this.workspaceId, docId);
  }

  /** The socket went: take the cursor off the doc. */
  close(): void {
    this.unfocus();
  }

  /**
   * The reply to `transcript`, heard at a pause, or null when it is not the
   * planning voice's: off a plan on this board, or on one whose run is over
   * and nobody said "interview me". An empty transcript is a silence.
   */
  answer(transcript: string, context: VoiceContext | undefined): InterviewReply | null {
    const cmd = interviewCommand(transcript);
    const run = this.run;
    if (!run) {
      if (cmd === 'start') return this.begin(context, true);
      const docId = docOf(context);
      if (!docId || this.over.has(docId) || !this.listensOn(context)) return null;
      return this.begin(context, false);
    }
    const text = transcript.trim();
    if (run.waiting) {
      if (cmd === 'enough') return this.settle(run, 'ended', 'Stopping here.');
      run.waiting = false;
      run.askedAt = this.now();
      return this.question(run, '');
    }
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
      case 'unsure':
        return this.quiet(run);
      default:
        if (bareAnswer(text)) return run.followedUp ? this.quiet(run) : this.followUp(run);
        return this.write(run, text);
    }
  }

  private begin(context: VoiceContext | undefined, asked: boolean): InterviewReply | null {
    const docId = docOf(context);
    if (!docId || !this.deps.docs.onBoard(this.workspaceId, docId)) {
      return this.say('Open a plan and say interview me there.');
    }
    const outline = this.deps.docs.outline(docId);
    if (!outline) return asked ? this.say('I can’t read this doc.') : null;
    const gaps = findPlanGaps(outline);
    if (gaps.length === 0) {
      // Unasked, there is nothing to say: keep listening, and look again at
      // the next pause, since the plan may have grown a question by then.
      return asked ? this.say('I found no gaps in this plan.') : this.hush(true);
    }
    this.over.delete(docId);
    const at = this.now();
    const run: Running = {
      id: this.newId(),
      docId,
      slots: new InterviewSlots(gaps),
      askedAt: at,
      startedAt: at,
      filledMs: 0,
      followedUp: false,
      waiting: false,
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
    this.recordAnswer(run, 'edit');
    return this.settle(run, 'placed', `Written under ${spokenHeading(gap)}.`, wordCount(text));
  }

  /** A bare answer: ask once for more, and write nothing yet. */
  private followUp(run: Running): InterviewReply {
    run.followedUp = true;
    this.recordAnswer(run, 'follow-up');
    return this.question(run, 'Can you say more?');
  }

  /** Nothing to write and nothing to press for: say nothing, put the
   *  question back, and ask the next one at the next pause. */
  private quiet(run: Running): InterviewReply {
    this.recordAnswer(run, 'quiet');
    this.recordGap(run, 'deferred');
    const { next, again } = run.slots.settle('deferred');
    run.followedUp = false;
    if (!next || again) {
      this.finish(run);
      return this.hush(false);
    }
    run.waiting = true;
    this.unfocus();
    return this.hush(true);
  }

  /** Record the current slot's outcome, settle it, and ask the next. */
  private settle(run: Running, how: SlotTransition, lead: string, words?: number): InterviewReply {
    this.recordGap(run, OUTCOME[how], words);
    const { next, again } = run.slots.settle(how);
    run.followedUp = false;
    run.waiting = false;
    if (how === 'ended') return this.ended(run, lead);
    if (!next) return this.ended(run, `${lead} That was the last gap.`);
    run.askedAt = this.now();
    return this.question(run, again ? `${lead} It’s the only one left:` : `${lead} Next:`);
  }

  private ended(run: Running, lead: string): InterviewReply {
    this.finish(run);
    const { slots } = run;
    return {
      ...this.say(`${lead} ${slots.placed} of ${plural(slots.total, 'gap')} filled.`),
      detail: slots.unasked.map((g) => `Not asked: ${gapLine(g)}`),
    };
  }

  private finish(run: Running): void {
    this.run = null;
    this.over.add(run.docId);
    this.unfocus();
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
  }

  /** The slot being asked; a running interview always has one. */
  private slot(run: Running): PlanGap {
    const gap = run.slots.current;
    if (!gap) throw new Error('interview running with no slot');
    return gap;
  }

  private question(run: Running, lead: string): InterviewReply {
    const gap = this.slot(run);
    this.focused = run.docId;
    this.deps.docs.focus(run.docId, {
      blockId: gap.asksId ?? gap.headingId,
      quote: gap.asks ?? gap.heading,
    });
    const spoken = capWords(`${lead} ${questionFor(gap)}`.trim(), SPOKEN_MAX_WORDS);
    return {
      spoken,
      detail: ['Say skip, come back to that, or that’s enough.'],
      asking: true,
      route: INTERVIEW_ROUTE,
    };
  }

  private unfocus(): void {
    if (this.focused) this.deps.docs.focus(this.focused, null);
    this.focused = null;
  }

  private say(spoken: string): InterviewReply {
    return { spoken, detail: [], asking: false, route: INTERVIEW_ROUTE };
  }

  /** Nothing said. `listening`: the page keeps listening for the next pause. */
  private hush(listening: boolean): InterviewReply {
    return { spoken: '', detail: [], asking: listening, route: INTERVIEW_ROUTE };
  }

  private recordAnswer(run: Running, after: AfterAnswer): void {
    const gap = this.slot(run);
    this.deps.log.record({
      type: 'answer',
      interview: run.id,
      docId: run.docId,
      section: gap.ordinal,
      kind: gap.kind,
      after,
      at: this.now(),
    });
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
