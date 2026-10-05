/**
 * The coach session's feed: every event, as it happens, to the Claude Code
 * session that is the coach (the owner, 2026-10-03: "routing all events to a
 * long running Claude Code session ... that can hold an ongoing
 * conversation with context").
 *
 * The session is the lead of the Coach board, launched once and kept
 * running all week by the fleet's respawn. Each frame is one addressed
 * frame to it on that board: what he did in the last window
 * (`coach.digest`), how he answered a moment (`coach.answer`), and how
 * readily he wants it to speak up (`coach.preference`). The session decides
 * whether to speak, and raises a moment through `POST /coach/moments`;
 * nothing here waits on it.
 *
 * Every frame is a session turn, and one turn per event cost 86 turns and
 * 9.7M tokens in five hours with nothing said. So what he does is held: the
 * first event opens a window, and when it closes 15 minutes later the
 * window goes as one digest (`coach/digest.ts`). A quiet stretch opens no
 * window and sends nothing. His answers and his setting go at once.
 *
 * A day has a budget of turns (`DAILY_EVENT_LIMIT`): past it nothing is
 * sent until his next local day, and the front page says the coach is
 * paused.
 *
 * With no lead, or a lead holding no stream, nothing is sent: an addressed
 * frame is replayed to a stream that comes back, so a session that is gone
 * would otherwise read a backlog of stale events when it returns.
 */
import { type DigestEvent, type DigestItem, digestOf } from './digest.ts';
import type { CoachEventKind } from './stream.ts';
import { type CoachReadiness, DAILY_EVENT_LIMIT, type MomentAnswer } from './types.ts';

interface Addressed {
  /** The Coach board, which the frame is addressed on. */
  workspaceId: string;
  at: number;
}

export type SessionFrame = Addressed &
  (
    | {
        event: 'coach.event';
        kind: CoachEventKind;
        /** The board he was on, by id and name. */
        boardId: string;
        board?: string;
        docId?: string;
        doc?: string;
        heading?: string;
        text?: string;
      }
    | {
        event: 'coach.answer';
        momentId: string;
        answer: MomentAnswer | 'moved-on';
        goal: string;
        line: string;
      }
    | { event: 'coach.preference'; readiness: CoachReadiness }
    | { event: 'coach.digest'; from: number; to: number; items: DigestItem[] }
  );

/** A frame before it is addressed. */
export type SessionNews = SessionFrame extends infer F
  ? F extends Addressed
    ? Omit<F, keyof Addressed>
    : never
  : never;

export interface SessionFeedDeps {
  /** The Coach board and its lead, or null when there is no board or no lead. */
  lead: () => { workspaceId: string; agentId: string } | null;
  /** Sends one addressed frame; answers how many of the lead's streams took it. */
  send: (workspaceId: string, agentId: string, frame: SessionFrame) => number;
  /** Whether the lead is holding a stream on its board now. */
  connected: (workspaceId: string, agentId: string) => boolean;
  /** Events already sent on `at`'s local day. */
  eventsOn: (at: number) => number;
  /** Turns a day; defaults to `DAILY_EVENT_LIMIT`. */
  dailyLimit?: number;
  /** A digest reached the session: one turn spent. */
  countTurn: (at: number) => void;
  now?: () => number;
  /** Runs `fn` after `ms`; answers a cancel. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** How long a window stays open before it goes as one digest. */
export const DIGEST_WINDOW_MS = 15 * 60_000;

const timer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class SessionFeed {
  private held: DigestEvent[] = [];
  private openedAt = 0;
  private cancel: (() => void) | null = null;

  constructor(private readonly deps: SessionFeedDeps) {}

  /** Whether a session would hear a frame sent now. */
  reachable(): boolean {
    const lead = this.deps.lead();
    return lead !== null && this.deps.connected(lead.workspaceId, lead.agentId);
  }

  /** The day's budget is spent: nothing more goes until tomorrow. */
  paused(at: number): boolean {
    return this.deps.eventsOn(at) >= (this.deps.dailyLimit ?? DAILY_EVENT_LIMIT);
  }

  /** An event joins the open window; anything else goes now. True when a
   *  session is there to take it. */
  send(news: SessionNews, at: number): boolean {
    if (news.event !== 'coach.event') return this.deliver(news, at);
    if (this.paused(at) || !this.reachable()) return false;
    const { event: _event, ...e } = news;
    this.held.push({ ...e, at });
    if (!this.cancel) {
      this.openedAt = (this.deps.now ?? Date.now)();
      this.cancel = (this.deps.schedule ?? timer)(() => this.close(), DIGEST_WINDOW_MS);
    }
    return true;
  }

  /** Drops a window still open, sending nothing. */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.held = [];
  }

  private close(): void {
    const at = (this.deps.now ?? Date.now)();
    const items = digestOf(this.held, at);
    this.cancel = null;
    this.held = [];
    if (items.length === 0) return;
    if (this.deliver({ event: 'coach.digest', from: this.openedAt, to: at, items }, at)) {
      this.deps.countTurn(at);
    }
  }

  private deliver(news: SessionNews, at: number): boolean {
    if (this.paused(at)) return false;
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return false;
    const frame = { ...news, workspaceId: lead.workspaceId, at } as SessionFrame;
    return this.deps.send(lead.workspaceId, lead.agentId, frame) > 0;
  }
}
