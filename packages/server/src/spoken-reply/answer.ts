import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import { capWords } from '../voice-status.ts';
/**
 * What a spoken question gets as an answer: the board mic's own router, cut
 * into a spoken part and a written part.
 *
 * Everything the router already answers — a status brief, a lookup, "did you
 * mean A or B?", a hand-off to the lead — is answered the same way here, so
 * every setup says the same words and only the ears and the voice differ.
 *
 * One ask is added, because the voice plan's example of an ambiguous request
 * is one the router has no fast path for: "how is the goal going?" on a
 * board with several goals. That asks ONE question — "Which goal: A or B?" —
 * and holds it for the next thing said on this socket, answered by ordinal
 * ("the second one") or by name. Anything else said clears it and is routed
 * as a new question. One goal is answered without asking; no goals falls
 * through to the router.
 */
import type { VoiceHandleResult, VoiceResult } from '../voice.ts';
import { parseOrdinal, pickByLabel } from '../voice.ts';
import type { SpokenInterview } from './interview.ts';
import { type ShapedReply, shapeReply, stripWake } from './reply-shape.ts';

/** The board as the answerer needs it — the router plus the goal list. */
export interface SpokenBoard {
  handle(
    workspaceId: string,
    req: { transcript: string; context?: VoiceContext; actor: VoiceActor },
  ): Promise<VoiceHandleResult>;
  goalStatus(workspaceId: string, goalId: string): VoiceResult | undefined;
  /** In priority order. */
  goals(workspaceId: string): Array<{ id: string; title: string }>;
}

export interface SpokenAnswer extends ShapedReply {
  /** When asking, the answers the page may offer as buttons. */
  choices?: string[];
  route: string;
  navigate?: string;
}

/** How many goals the question names aloud. More than this is "or another". */
const NAMED_GOALS = 3;
const GOAL_LABEL_WORDS = 5;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GOAL_PATTERNS: readonly RegExp[] = [
  /^(?:how(?:'s| is| are)|hows) (?:the |my |our )?goals? (?:going|doing|coming along)$/,
  /^(?:what(?:'s| is)|whats|where(?:'s| is)|wheres) (?:the |my |our )?goals? (?:at|status)$/,
  /^(?:(?:give me |what(?:'s| is) )?(?:the |a )?)?(?:status|progress|update) (?:on|of) (?:the |my |our )?goals?$/,
  /^(?:the |my |our )?goals? (?:status|progress|update)$/,
];

/** "how is the goal going?" — about A goal, with no goal named. */
export function goalAsk(transcript: string): boolean {
  const s = normalize(transcript);
  return GOAL_PATTERNS.some((p) => p.test(s));
}

/** "how is the sign-in goal going?" — the words between the article and
 *  "goal", when a goal was named. */
export function namedGoalAsk(transcript: string): string | null {
  const m = normalize(transcript).match(
    /^(?:how(?:'s| is)|hows) (?:the |my |our )?(.+?) goal (?:going|doing|coming along)$/,
  );
  const name = m?.[1];
  return name && !/^(?:the|my|our)$/.test(name) ? name : null;
}

function listOr(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

export class SpokenAnswerer {
  /** The goal question awaiting its answer, per socket. */
  private pendingGoals: Array<{ id: string; label: string }> | null = null;

  constructor(
    private readonly board: SpokenBoard,
    private readonly workspaceId: string,
    /** Interview mode (`interview.ts`), asked before anything else. */
    private readonly interview?: SpokenInterview,
  ) {}

  get asking(): boolean {
    return this.pendingGoals !== null;
  }

  /** While an interview runs, what was heard is written into the doc, so a
   *  listener's paraphrase of it must not stand in for it. */
  get verbatim(): boolean {
    return this.interview?.active === true;
  }

  async answer(
    heard: string,
    actor: VoiceActor,
    context: VoiceContext | undefined,
  ): Promise<SpokenAnswer> {
    const transcript = stripWake(heard);
    const interviewed = this.interview?.answer(transcript, context);
    if (interviewed) return interviewed;
    if (!transcript) return { spoken: '', detail: [], asking: false, route: 'none' };

    const pending = this.pendingGoals;
    this.pendingGoals = null;
    if (pending) {
      const at = parseOrdinal(transcript, pending.length);
      const picked = at !== null ? pending[at] : pickByLabel(transcript, pending);
      if (picked) return this.goalAnswer(picked.id);
    }

    const goals = this.board.goals(this.workspaceId);
    const named = namedGoalAsk(transcript);
    if (named && goals.length > 0) {
      const hit = pickByLabel(
        named,
        goals.map((g) => ({ id: g.id, label: g.title })),
      );
      if (hit) return this.goalAnswer(hit.id);
    }
    if (goalAsk(transcript) && goals.length > 0) {
      const only = goals.length === 1 ? goals[0] : undefined;
      if (only) return this.goalAnswer(only.id);
      return this.askWhichGoal(goals);
    }

    const r = await this.board.handle(this.workspaceId, { transcript, context, actor });
    if (!r.ok) {
      return { spoken: 'I can’t find this board.', detail: [], asking: false, route: 'none' };
    }
    return {
      ...shapeReply(r.ack),
      route: r.route,
      ...(r.navigate ? { navigate: r.navigate } : {}),
    };
  }

  private goalAnswer(goalId: string): SpokenAnswer {
    const r = this.board.goalStatus(this.workspaceId, goalId);
    if (!r) return { spoken: 'That goal is gone.', detail: [], asking: false, route: 'none' };
    return { ...shapeReply(r.ack), route: r.route };
  }

  private askWhichGoal(goals: Array<{ id: string; title: string }>): SpokenAnswer {
    const options = goals.map((g) => ({
      id: g.id,
      label: g.title,
      short: capWords(g.title, GOAL_LABEL_WORDS),
    }));
    this.pendingGoals = options.map(({ id, label }) => ({ id, label }));
    const named = options.slice(0, NAMED_GOALS).map((o) => o.short);
    if (options.length > NAMED_GOALS) named.push('another');
    const ordinals = ['first', 'second', 'third'].slice(0, Math.min(NAMED_GOALS, options.length));
    return {
      spoken: `Which goal: ${listOr(named)}?`,
      detail: [`Say ${listOr(ordinals)}, or a goal’s name.`],
      asking: true,
      choices: options.slice(0, NAMED_GOALS).map((o) => o.short),
      route: 'fast-path',
    };
  }
}
