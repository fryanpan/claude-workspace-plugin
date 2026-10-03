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
 * THE WRITE is `DocStore.applyBlockEdits` with `insert_under_heading`, the
 * MCP block tools' verb: an ordinary edit of the live doc, so threads keep
 * their anchors and the bound file gets it at the next write-back.
 *
 * QUESTIONS COME FROM READING THE PLAN when the server has a model: at a
 * pause somebody spoke into, one call (`interview-reader.ts`) names the one
 * question worth asking now, or none, the gap list among its inputs. "Any
 * questions?" always gets an answer: the best question, or one sentence on
 * why there is none. Without a model, or at a silent pause, the gap list is
 * asked in order. In a planning meeting the notes' copy of an answer is held
 * while the question is out (`InterviewDocs.hold`, `meeting-ears.ts`).
 *
 * THE DOC is the one the page says it is on, accepted only after
 * `InterviewDocs.onBoard` confirms it belongs to this socket's board — the
 * same membership check the router makes, because the page's context is
 * only clamped, never trusted, before it gets here.
 */
import { SPOKEN_MAX_WORDS } from '@claude-workspaces/core/spoken-reply';
import type { VoiceContext } from '../voice-prompt.ts';
import { capWords } from '../voice-status.ts';
import { answerPart } from './interview-answer.ts';
import {
  type PlanGap,
  findPlanGaps,
  gapLine,
  questionFor,
  spokenHeading,
} from './interview-gaps.ts';
import type { AfterAnswer, GapOutcome, InterviewLog } from './interview-log.ts';
import {
  answerMarkdown,
  asksForQuestions,
  bareAnswer,
  interviewCommand,
  wordCount,
} from './interview-phrases.ts';
import { type PlanComplete, readPlan } from './interview-reader.ts';
import { InterviewRecord, OUTCOME, type Running } from './interview-record.ts';
import { InterviewSlots, type SlotTransition } from './interview-state.ts';

/** The route word an interview's replies carry. */
export const INTERVIEW_ROUTE = 'interview';
export type InterviewWrite = 'written' | 'gone' | 'failed';
/** The most of what was said since the last question a reading is given. */
const HEARD_KEPT = 2_000;

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
  /** A question is out on `docId`: hold the meeting notes' copy of what is
   *  said next (`MeetingEars.hold`). The three are absent off a meeting. */
  hold?(docId: string): void;
  /** `written` went into the plan: the notes never get the turns it holds. */
  placed?(docId: string, written: string): void;
  /** No answer was written: the notes get what was held. */
  release?(docId: string): void;
}

export interface SpokenInterviewDeps {
  docs: InterviewDocs;
  log: InterviewLog;
  /** One model call, to choose a question by reading the plan. Absent: the
   *  gap list only. */
  complete?: PlanComplete;
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

function docOf(context: VoiceContext | undefined): string | undefined {
  return context?.surface === 'doc' ? context.docId : undefined;
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
  /** The questions asked on each doc, so a reading never repeats one. */
  private readonly asked = new Map<string, string[]>();
  /** What was said at pauses since the last question, per doc: a reading
   *  hears all of it, not only the last turn. */
  private readonly since = new Map<string, string>();
  /** What `since` held when the latest question was asked. */
  private sinceAsked = '';
  /** The latest turn was heard in a planning meeting. */
  private meeting = false;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly record: InterviewRecord;

  constructor(
    private readonly deps: SpokenInterviewDeps,
    private readonly workspaceId: string,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => `iv-${Date.now().toString(36)}`);
    this.record = new InterviewRecord(deps.log, this.now);
  }

  get active(): boolean {
    return this.run !== null;
  }

  /** Whether what is said in `context` is the planning voice's to hear. */
  listensOn(context: VoiceContext | undefined): boolean {
    const docId = docOf(context);
    return docId !== undefined && this.deps.docs.onBoard(this.workspaceId, docId);
  }

  /** The socket went: take the cursor off the doc, and a meeting's run
   *  ends with it. */
  close(): void {
    this.unfocus();
    this.record.close();
  }

  /**
   * The question just asked was never heard: the speaker went on over it
   * (`cut-in.ts`), so what they say next is not its answer. A reading's
   * question is dropped as if it had not been asked, and the next pause reads
   * again with everything said; a gap's is asked again at the next pause.
   */
  withdraw(): void {
    const run = this.run;
    if (!run) return;
    const asked = questionFor(this.slot(run));
    this.asked.set(
      run.docId,
      (this.asked.get(run.docId) ?? []).filter((q) => q !== asked),
    );
    if (this.sinceAsked) this.since.set(run.docId, this.sinceAsked);
    if (run.reading) this.run = null;
    else run.waiting = true;
    this.unfocus();
  }

  /**
   * The reply to `transcript`, heard at a pause, or null when it is not the
   * planning voice's: off a plan on this board, or on one whose run is over
   * and nobody said "interview me". An empty transcript is a silence.
   * `meeting`: heard in a planning meeting, where nothing said is ever the
   * board router's, so the voice stays quiet rather than returning null.
   * `invited`: somebody asked for its questions, whatever the words.
   */
  async answer(
    transcript: string,
    context: VoiceContext | undefined,
    meeting = false,
    invited = false,
  ): Promise<InterviewReply | null> {
    this.meeting = meeting;
    const cmd = invited && this.run ? 'repeat' : interviewCommand(transcript);
    const run = this.run;
    if (!run) {
      if (cmd === 'start') return this.begin(context, transcript, 'asked');
      const docId = docOf(context);
      const asks = invited || asksForQuestions(transcript);
      if (!docId || !this.listensOn(context)) return meeting ? this.hush(true) : null;
      if (meeting && cmd === 'enough') {
        this.over.add(docId);
        return this.say('I’ll stop asking.');
      }
      if (this.over.has(docId) && !asks) return meeting ? this.hush(true) : null;
      return this.begin(context, transcript, asks ? 'invited' : 'pause');
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

  /** `why`: said "interview me", asked "any questions?", or just paused. */
  private async begin(
    context: VoiceContext | undefined,
    heard: string,
    why: 'asked' | 'invited' | 'pause',
  ): Promise<InterviewReply | null> {
    const docId = docOf(context);
    if (!docId || !this.deps.docs.onBoard(this.workspaceId, docId)) {
      return this.say('Open a plan and say interview me there.');
    }
    const outline = this.deps.docs.outline(docId);
    if (!outline) return why === 'pause' ? null : this.say('I can’t read this doc.');
    const gaps = findPlanGaps(outline);
    // A reading costs a model call, so it is made only for words somebody
    // said since the last question; "interview me" asks the gap list.
    if (this.deps.complete && why !== 'asked' && heard.trim()) {
      const read = await this.read(docId, outline, gaps, heard, why === 'invited');
      if ('ask' in read) {
        this.over.delete(docId);
        return this.question(this.open(docId, [read.ask], true), '');
      }
      if (why !== 'invited') return this.hush(true);
      // "No." is the answer; the reason is written, never said (Bryan,
      // 3 Oct: a sentence where "no" would do wastes the listener's time).
      const reason = read.none.replace(/[.!]*$/, '');
      return { ...this.say('No.'), detail: reason ? [`${reason}.`] : [], asking: true };
    }
    if (gaps.length === 0) {
      // Unasked, there is nothing to say: keep listening, and look again at
      // the next pause, since the plan may have grown a question by then.
      return why === 'pause' ? this.hush(true) : this.say('I found no gaps in this plan.');
    }
    this.over.delete(docId);
    const run = this.open(docId, gaps, false);
    return {
      ...this.question(run, `I found ${plural(gaps.length, 'gap')}. First:`),
      detail: gaps.map((g, i) => `${i + 1}. ${gapLine(g)}`),
    };
  }

  private open(docId: string, gaps: readonly PlanGap[], reading: boolean): Running {
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
      reading,
    };
    this.run = run;
    return run;
  }

  private read(
    docId: string,
    outline: readonly prose.OutlineEntry[],
    gaps: readonly PlanGap[],
    heard: string,
    invited: boolean,
  ) {
    const complete = this.deps.complete;
    if (!complete) return Promise.resolve({ none: '' });
    const all = `${this.since.get(docId) ?? ''} ${heard}`.trim().slice(-HEARD_KEPT);
    this.since.set(docId, all);
    return readPlan(complete, {
      outline,
      gaps,
      heard: all,
      asked: this.asked.get(docId) ?? [],
      invited,
    });
  }

  /** After a reading's question is settled: read again for the next one,
   *  with what was just said. Nothing to ask leaves `lead` alone. */
  private async readNext(docId: string, lead: string, heard: string): Promise<InterviewReply> {
    const outline = this.deps.docs.outline(docId);
    const read = outline
      ? await this.read(docId, outline, findPlanGaps(outline), heard, false)
      : { none: '' };
    if (!('ask' in read)) return { ...this.say(lead), asking: true };
    return this.question(this.open(docId, [read.ask], true), `${lead} Next:`);
  }

  private async write(run: Running, text: string): Promise<InterviewReply> {
    // Only what answers the question goes in; the rest stays with the notes.
    const kept = await answerPart(this.deps.complete, questionFor(this.slot(run)), text);
    if (!kept) return this.quiet(run);
    const markdown = answerMarkdown(kept);
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
    this.deps.docs.placed?.(run.docId, kept);
    run.filledMs += this.now() - run.askedAt;
    this.recordAnswer(run, 'edit');
    return this.settle(
      run,
      'placed',
      `Written under ${spokenHeading(gap)}.`,
      wordCount(kept),
      text,
    );
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
      this.finish(run, !run.reading);
      return this.hush(run.reading);
    }
    run.waiting = true;
    this.unfocus();
    return this.hush(true);
  }

  /** Record the current slot's outcome, settle it, and ask the next. */
  private async settle(
    run: Running,
    how: SlotTransition,
    lead: string,
    words?: number,
    heard = '',
  ): Promise<InterviewReply> {
    this.recordGap(run, OUTCOME[how], words);
    const { next, again } = run.slots.settle(how);
    run.followedUp = false;
    run.waiting = false;
    if (how === 'ended') return this.ended(run, lead);
    if (!next && run.reading) {
      this.finish(run, false);
      return this.readNext(run.docId, lead, heard);
    }
    if (!next) return this.ended(run, `${lead} That was the last gap.`);
    run.askedAt = this.now();
    return this.question(run, again ? `${lead} It’s the only one left:` : `${lead} Next:`);
  }

  private ended(run: Running, lead: string): InterviewReply {
    this.finish(run, true);
    if (run.reading) return this.say(lead);
    const { slots } = run;
    return {
      ...this.say(`${lead} ${slots.placed} of ${plural(slots.total, 'gap')} filled.`),
      detail: slots.unasked.map((g) => `Not asked: ${gapLine(g)}`),
    };
  }

  /** `over`: the doc hears no unasked question again on this socket. In a
   *  meeting the run's end is logged when the meeting's socket goes. */
  private finish(run: Running, over: boolean): void {
    this.run = null;
    if (over) this.over.add(run.docId);
    this.unfocus();
    this.record.end(run, this.meeting);
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
      // A reading's question is the model's words, not the plan's.
      quote: (gap.kind === 'read' ? gap.quote : gap.asks) ?? gap.heading,
    });
    this.deps.docs.hold?.(run.docId);
    this.sinceAsked = this.since.get(run.docId) ?? '';
    this.since.delete(run.docId);
    const asked = questionFor(gap);
    const before = this.asked.get(run.docId) ?? [];
    if (!before.includes(asked)) this.asked.set(run.docId, [...before, asked]);
    const spoken = capWords(`${lead} ${asked}`.trim(), SPOKEN_MAX_WORDS);
    return {
      spoken,
      // A meeting has no interview commands to offer (the page shows none).
      detail: this.meeting ? [] : ['Say skip, come back to that, or that’s enough.'],
      asking: true,
      route: INTERVIEW_ROUTE,
    };
  }

  private unfocus(): void {
    if (this.focused) {
      this.deps.docs.focus(this.focused, null);
      this.deps.docs.release?.(this.focused);
    }
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
    this.record.answer(run, this.slot(run), after);
  }

  private recordGap(run: Running, outcome: GapOutcome, words?: number): void {
    this.record.gap(run, this.slot(run), outcome, words);
  }
}
