/**
 * The planning voice on a learning-goals doc (`coach/goals-doc.ts`): it asks
 * at most two things — the coach's name, and what the owner wants to do
 * better — and then follows the speaker.
 *
 * The owner's first goals interview walked one section at a time, re-queued
 * whatever did not fit the question out, and could not go back (Bryan, 6 Oct:
 * "the flow was too structured and too rigid"). So here nothing is a slot.
 * Every pause somebody spoke into is read once (`interview-goals-place.ts`)
 * and each change lands where it belongs: a name under the name heading, each
 * new goal as its own bullet in the goals section, and a revision on the goal
 * it names, through `replace_block`. A goal the owner typed becomes a proposal
 * there (`prose-batch.ts`), so typed words are never deleted.
 *
 * A doc is a goals doc when a heading reads "What I want to do better". On a
 * doc from before 5 Oct, with one `##` per goal and four `###` parts, new
 * goals go under the first such heading and the other parts are never asked.
 *
 * A question asked is never asked again on this socket, answered or not.
 */
import type { prose } from '@claude-workspaces/core';
import { GOALS_HEADING, NAME_HEADING } from '../coach/goals-doc.ts';
import { type GoalsPlacement, placeGoals } from './interview-goals-place.ts';
import {
  type InterviewCommand,
  MAX_ANSWER_CHARS,
  answerMarkdown,
  asksForQuestions,
  bareAnswer,
  oneSentence,
} from './interview-phrases.ts';
import type { PlanComplete } from './interview-reader.ts';
import {
  INTERVIEW_ROUTE,
  type InterviewDocs,
  type InterviewReply,
  type InterviewWrite,
} from './interview-types.ts';

type Ask = 'name' | 'better';

const QUESTION: Record<Ask, string> = {
  name: 'What should your coach be called?',
  better: 'What do you want to do better?',
};

const norm = (s: string) => s.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

interface GoalsShape {
  nameHeading?: prose.OutlineEntry;
  nameBlocks: prose.OutlineEntry[];
  goalsHeading: prose.OutlineEntry;
  /** One block per goal: a top-level bullet or a paragraph. */
  goals: prose.OutlineEntry[];
}

/** The doc as goals, or null when no heading reads "What I want to do better". */
export function goalsShape(outline: readonly prose.OutlineEntry[]): GoalsShape | null {
  const headings = outline.filter((b) => b.kind === 'heading');
  const goalHeads = headings.filter((h) => norm(h.text) === norm(GOALS_HEADING));
  const goalsHeading = goalHeads[0];
  if (!goalsHeading) return null;
  const nameHeading = headings.find((h) => norm(h.text) === norm(NAME_HEADING));
  const said = (b: prose.OutlineEntry) => b.kind !== 'heading' && b.text.trim().length > 0;
  const ids = new Set(goalHeads.map((h) => h.id));
  return {
    goalsHeading,
    goals: outline.filter(
      (b) =>
        said(b) &&
        b.underHeadingId !== undefined &&
        ids.has(b.underHeadingId) &&
        (b.kind !== 'listItem' || (b.depth ?? 0) === 0),
    ),
    ...(nameHeading ? { nameHeading } : {}),
    nameBlocks: nameHeading
      ? outline.filter((b) => said(b) && b.underHeadingId === nameHeading.id)
      : [],
  };
}

const bullet = (text: string) => `- ${text.replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_CHARS)}`;

export class GoalsInterview {
  private readonly asked = new Map<string, Set<Ask>>();
  /** The question out, and the doc it is on. */
  private out: { docId: string; ask: Ask } | null = null;
  /** Docs where the speaker said "that's enough": quiet until asked again. */
  private readonly over = new Set<string>();
  private engagedOn: string | null = null;

  constructor(
    private readonly docs: InterviewDocs,
    private readonly complete?: PlanComplete,
  ) {}

  /** Whether `docId` is a learning-goals doc. */
  claims(docId: string): boolean {
    const outline = this.docs.outline(docId);
    return outline !== null && goalsShape(outline) !== null;
  }

  /** A goals doc is being talked through: what is heard is written into it. */
  get engaged(): boolean {
    return this.engagedOn !== null;
  }

  close(): void {
    this.clearOut();
    this.engagedOn = null;
  }

  /** The question was talked over: it may be asked again at the next pause. */
  withdraw(): void {
    const out = this.out;
    if (!out) return;
    this.asked.get(out.docId)?.delete(out.ask);
    this.clearOut();
  }

  async turn(
    docId: string,
    transcript: string,
    cmd: InterviewCommand | null,
    opts: { invited: boolean; meeting: boolean },
  ): Promise<InterviewReply | null> {
    const text = transcript.trim();
    const asks = opts.invited || asksForQuestions(text);
    if (this.over.has(docId)) {
      if (cmd !== 'start' && !asks) return opts.meeting ? hush() : null;
      this.over.delete(docId);
    }
    const shape = this.shape(docId);
    if (!shape) return null;
    this.engagedOn = docId;
    const outHere = this.out?.docId === docId ? this.out.ask : null;
    switch (cmd) {
      case 'enough':
        this.over.add(docId);
        this.close();
        return say('I’ll stop asking.', false);
      case 'start':
      case 'repeat':
        return this.ask(docId, shape, outHere) ?? say('I have nothing to ask.', true);
      case 'skip':
      case 'later':
      case 'unsure':
        this.clearOut();
        return this.ask(docId, shape) ?? hush();
    }
    if (!text) return outHere ? hush() : (this.ask(docId, shape) ?? hush());
    if (bareAnswer(text)) return hush();
    return this.place(docId, shape, text, outHere);
  }

  private shape(docId: string): GoalsShape | null {
    const outline = this.docs.outline(docId);
    return outline ? goalsShape(outline) : null;
  }

  /** `again`, or the next question not yet asked on this doc; null when
   *  there is none and the speaker is simply talking. */
  private ask(docId: string, shape: GoalsShape, again: Ask | null = null): InterviewReply | null {
    const asked = this.asked.get(docId) ?? new Set<Ask>();
    this.asked.set(docId, asked);
    const due: Ask | null =
      again ??
      (shape.nameHeading && shape.nameBlocks.length === 0 && !asked.has('name')
        ? 'name'
        : shape.goals.length === 0 && !asked.has('better')
          ? 'better'
          : null);
    if (!due) return null;
    asked.add(due);
    this.out = { docId, ask: due };
    const at = due === 'name' && shape.nameHeading ? shape.nameHeading : shape.goalsHeading;
    this.docs.focus(docId, { blockId: at.id, quote: at.text });
    return { ...say(QUESTION[due], true), detail: ['Say as much as you like, in any order.'] };
  }

  private async place(
    docId: string,
    shape: GoalsShape,
    text: string,
    asked: Ask | null,
  ): Promise<InterviewReply> {
    const placed = await placeGoals(this.complete, {
      name: shape.nameBlocks.map((b) => b.text).join(' '),
      goals: shape.goals.map((g) => g.text),
      asked,
      heard: text,
    });
    const { writes, detail } = this.apply(docId, shape, placed);
    if (writes.length === 0) return hush();
    if (writes.some((w) => w !== 'written')) return say('I couldn’t write all of that.', true);
    this.docs.placed?.(docId, text);
    this.clearOut();
    const fresh = this.shape(docId);
    const next = fresh ? this.ask(docId, fresh) : null;
    const ack =
      placed.change.length > 0 && placed.add.length === 0 && !placed.name
        ? `Changed goal ${placed.change.map((c) => c.goal).join(' and ')}.`
        : 'Got it.';
    return { ...(next ?? say(ack, true)), detail };
  }

  private apply(
    docId: string,
    shape: GoalsShape,
    placed: GoalsPlacement,
  ): { writes: InterviewWrite[]; detail: string[] } {
    const writes: InterviewWrite[] = [];
    const detail: string[] = [];
    const add = [...placed.add];
    if (placed.name && shape.nameHeading) {
      const md = answerMarkdown(placed.name);
      const first = shape.nameBlocks[0];
      writes.push(
        first
          ? this.docs.replaceBlock(docId, first.id, md)
          : this.docs.writeUnder(docId, shape.nameHeading.id, md),
      );
      detail.push(`Name: ${placed.name}`);
    }
    for (const c of placed.change) {
      const goal = shape.goals[c.goal - 1];
      if (!goal) {
        add.push(c.text);
        continue;
      }
      const md = goal.kind === 'listItem' ? bullet(c.text) : answerMarkdown(c.text);
      writes.push(this.docs.replaceBlock(docId, goal.id, md));
      detail.push(`Goal ${c.goal} now: ${c.text}`);
    }
    if (add.length > 0) {
      writes.push(this.docs.writeUnder(docId, shape.goalsHeading.id, add.map(bullet).join('\n')));
      detail.push(...add.map((g) => `Added: ${g}`));
    }
    return { writes, detail };
  }

  private clearOut(): void {
    if (this.out) this.docs.focus(this.out.docId, null);
    this.out = null;
  }
}

function say(text: string, asking: boolean): InterviewReply {
  const { spoken, rest } = oneSentence(text);
  return { spoken, detail: rest, asking, route: INTERVIEW_ROUTE };
}

function hush(): InterviewReply {
  return { spoken: '', detail: [], asking: true, route: INTERVIEW_ROUTE };
}
