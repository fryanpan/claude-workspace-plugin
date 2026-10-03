/**
 * The coach's judge is a Claude Code session, not a one-shot model call
 * (Bryan, 2026-10-03: "routing all events to a long running Claude Code
 * session ... that can hold an ongoing conversation with context").
 *
 * The session is the lead of the Coach board. When a trigger passes every
 * gate, this sends it one addressed frame (`coach.candidate`) carrying what
 * a one-shot call would have been sent: his goals, where he is, where he has
 * been and what he did, and the reply format. The session answers through
 * `POST /coach/candidates/:id/reply`, and that answer settles the judgement
 * the coach is waiting on, so the moment reaches his page the moment the
 * session decides.
 *
 * The server still checks the answer: it must quote one of his "act
 * differently when" lines (`parseCoachReply`), and the spacing and the daily
 * cap still hold. A session that does not answer within `ANSWER_WITHIN_MS`
 * is no answer, and a board with no lead attached is asked nothing.
 */
import { randomBytes } from 'node:crypto';
import type { CoachGenerator } from './moment.ts';

export const CANDIDATE_EVENT = 'coach.candidate';
/** How long a candidate waits for the session's answer. */
export const ANSWER_WITHIN_MS = 3 * 60_000;
const CANDIDATE_ID = /^cc-[A-Za-z0-9_-]{12}$/;

export interface CandidateFrame {
  event: typeof CANDIDATE_EVENT;
  workspaceId: string;
  candidateId: string;
  at: number;
  /** How to judge, and the JSON to answer with. */
  system: string;
  /** What he is doing, in the prompt's words. */
  prompt: string;
  /** The route the answer goes to. */
  replyPath: string;
}

export interface SessionJudgeDeps {
  /** The Coach board and its lead, or null when there is no board or no lead. */
  lead: () => { workspaceId: string; agentId: string } | null;
  /** Sends one addressed frame; answers how many of the lead's streams took it. */
  send: (workspaceId: string, agentId: string, frame: CandidateFrame) => number;
  /** Whether the lead is holding a stream on its board now. */
  connected?: (workspaceId: string, agentId: string) => boolean;
  now?: () => number;
  answerWithinMs?: number;
}

interface Pending {
  resolve: (reply: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionJudge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: SessionJudgeDeps) {}

  /** Whether a session could be asked now: the board has a lead, and it is listening. */
  reachable(): boolean {
    const lead = this.deps.lead();
    if (!lead) return false;
    return this.deps.connected?.(lead.workspaceId, lead.agentId) ?? true;
  }

  /** The coach's model seam, answered by the session. */
  readonly generate: CoachGenerator = ({ system, user }) => {
    const lead = this.deps.lead();
    if (!lead) return Promise.resolve(null);
    const candidateId = `cc-${randomBytes(9).toString('base64url')}`;
    const frame: CandidateFrame = {
      event: CANDIDATE_EVENT,
      workspaceId: lead.workspaceId,
      candidateId,
      at: (this.deps.now ?? Date.now)(),
      system,
      prompt: user,
      replyPath: `/coach/candidates/${candidateId}/reply`,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settle(candidateId, null),
        this.deps.answerWithinMs ?? ANSWER_WITHIN_MS,
      );
      timer.unref?.();
      this.pending.set(candidateId, { resolve, timer });
      if (this.deps.send(lead.workspaceId, lead.agentId, frame) === 0)
        this.settle(candidateId, null);
    });
  };

  /** The session's answer. False when the candidate is unknown or has lapsed. */
  reply(candidateId: string, reply: string): boolean {
    if (!CANDIDATE_ID.test(candidateId) || !this.pending.has(candidateId)) return false;
    this.settle(candidateId, reply);
    return true;
  }

  get waiting(): number {
    return this.pending.size;
  }

  close(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }

  private settle(candidateId: string, reply: string | null): void {
    const p = this.pending.get(candidateId);
    if (!p) return;
    this.pending.delete(candidateId);
    clearTimeout(p.timer);
    p.resolve(reply);
  }
}
