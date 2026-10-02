/**
 * The order of the lines inside Incoming Messages. Agents rank the lines
 * and nothing else: the front page's sections keep a fixed order.
 *
 * `fyi` lines never rank above a line that asks for something. Then the
 * reader's urgency tier, then the project order the front page shows, then
 * that board's goal order, then a sender Bryan has written to before, then
 * the newest message.
 */
import type { InboxGoalRef, InboxRow, ReplyBy } from './types.ts';

const TIER: Record<ReplyBy, number> = { today: 0, tomorrow: 1, 'this-week': 2, 'when-free': 3 };
const LAST = Number.MAX_SAFE_INTEGER;

export interface RankContext {
  /** 1-based project rank of a board on the front page. */
  projectRank: (workspaceId: string) => number | undefined;
  /** 0-based place of a goal in its board's goal order. */
  goalIndex: (goal: InboxGoalRef) => number | undefined;
}

export function rankRows(rows: readonly InboxRow[], ctx: RankContext): InboxRow[] {
  const key = (r: InboxRow): number[] => [
    r.askKind === 'fyi' ? 1 : 0,
    TIER[r.replyBy] ?? LAST,
    r.goal ? (ctx.projectRank(r.goal.workspaceId) ?? LAST) : LAST,
    r.goal ? (ctx.goalIndex(r.goal) ?? LAST) : LAST,
    r.senderKnown ? 0 : 1,
    -r.receivedAt,
  ];
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.id.localeCompare(b.id);
  });
}
