/**
 * The plan lead's rank for single review items, across every board.
 *
 * Team Lead (the lead of the plan board `review-plan.ts` names) reads each new
 * ask as it arrives (`ask-feed.ts`) and places it against the week's goals.
 * Home's queue then puts ranked items first, lowest rank first, and every
 * unranked item after them in exactly the order it had before
 * (`applyLeadRanks` in `cross-review-queue.ts`).
 *
 * Stored here, on the plan side, not beside each item. The rank is one
 * agent's opinion about items on other boards. Beside the item it would need
 * a write path into every item kind (a task's review list, a doc thread's
 * comment in the `.ydoc`), and it would travel with the item into that
 * board's own reads and share views, where the plan lead's opinion means
 * nothing. Here there is one writer, one file, and nothing on the boards
 * changes.
 *
 * **A person's move wins.** When a person moves a task on its board after
 * the rank was set, every rank on that task's items stops counting: what
 * Bryan placed by hand is not overridden by an agent's opinion from before.
 * A rank set after his move counts again, because it was made knowing it.
 * Nothing is deleted when a move voids a rank; the entry stays, unread.
 *
 * Keys are the queue's own (`<workspaceId>:<row key>`), the same spelling the
 * feed hands the lead. A rank on an item that has since been answered is
 * harmless; entries older than `RANK_TTL_MS` are dropped on the next write.
 *
 * **A goal tag beside the rank.** The same lead files each item under one of
 * the plan board's goals, `urgent`, `not-this-week` or `drop`, and Home groups
 * the queue by it (`landing-goals.ts`). It is stored and voided exactly as a
 * rank is, with its own time, so a tag set after Bryan's move counts while a
 * rank from before it does not.
 *
 * One small JSON file (`review-ranks.json`), rewritten whole through a temp
 * file on each change.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILENAME = 'review-ranks.json';

/** The highest rank accepted. A week holds ~200 asks; this is far above it. */
export const MAX_RANK = 10_000;

/** A rank older than this is dropped on the next write. */
export const RANK_TTL_MS = 30 * 24 * 60 * 60_000;

/** The tags that are not a goal id. */
export const URGENT_TAG = 'urgent';
export const NOT_THIS_WEEK_TAG = 'not-this-week';
export const DROP_TAG = 'drop';
const FIXED_TAGS: ReadonlySet<string> = new Set([URGENT_TAG, NOT_THIS_WEEK_TAG, DROP_TAG]);

export interface LeadTag {
  goal: string;
  at: number;
  by: string;
}

export interface LeadRank {
  rank: number;
  /** When it was set. */
  at: number;
  /** The agent that set it. */
  by: string;
}

interface Stored {
  ranks: Record<string, LeadRank>;
  tags?: Record<string, LeadTag>;
  /** `<workspaceId>:<taskId>` → when a person last moved that task. */
  personMoves: Record<string, number>;
}

const isRank = (v: unknown): v is LeadRank => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    Number.isInteger(r.rank) &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    typeof r.by === 'string'
  );
};

const isTag = (v: unknown): v is LeadTag => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.goal === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    typeof r.by === 'string'
  );
};

/** A goal tag a caller sent: one of the fixed tags, one of `goalIds`, or null
 *  to clear. Anything else is refused. */
export function parseGoalTag(raw: unknown, goalIds: readonly string[]): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  return FIXED_TAGS.has(raw) || goalIds.includes(raw) ? raw : undefined;
}

/** A rank a caller sent: a whole number from 1 to `MAX_RANK`, or null to
 *  clear. Anything else is refused rather than coerced. */
export function parseRank(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return raw >= 1 && raw <= MAX_RANK ? raw : undefined;
}

export class ReviewRanks {
  private readonly path: string;
  private readonly ranks = new Map<string, LeadRank>();
  private readonly tags = new Map<string, LeadTag>();
  private readonly personMoves = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dataDir, FILENAME);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored>;
      for (const [key, value] of Object.entries(parsed.ranks ?? {})) {
        if (isRank(value)) this.ranks.set(key, value);
      }
      for (const [key, value] of Object.entries(parsed.tags ?? {})) {
        if (isTag(value)) this.tags.set(key, value);
      }
      for (const [key, at] of Object.entries(parsed.personMoves ?? {})) {
        if (typeof at === 'number' && Number.isFinite(at)) this.personMoves.set(key, at);
      }
    } catch {
      // A corrupt file loses the lead's ranks: Home falls back to the plan
      // order, which reorders a list and hides nothing.
    }
  }

  /** Sets or clears one item's rank. */
  set(key: string, rank: number | null, by: string): void {
    if (rank === null) this.ranks.delete(key);
    else this.ranks.set(key, { rank, at: this.now(), by });
    this.write();
  }

  /** Sets or clears one item's goal tag. */
  setGoal(key: string, goal: string | null, by: string): void {
    if (goal === null) this.tags.delete(key);
    else this.tags.set(key, { goal, at: this.now(), by });
    this.write();
  }

  /** A person moved this task on its board. */
  notePersonMove(workspaceId: string, taskId: string, at: number): void {
    const key = `${workspaceId}:${taskId}`;
    if ((this.personMoves.get(key) ?? 0) >= at) return;
    this.personMoves.set(key, at);
    this.write();
  }

  /**
   * The rank that counts for an item, or undefined: none was set, or a person
   * moved the item's task after it was set.
   */
  rankOf(key: string, workspaceId: string, taskId?: string): number | undefined {
    const r = this.ranks.get(key);
    return r && !this.movedSince(r.at, workspaceId, taskId) ? r.rank : undefined;
  }

  /** The goal tag that counts for an item, on the same terms as `rankOf`. */
  goalOf(key: string, workspaceId: string, taskId?: string): string | undefined {
    const t = this.tags.get(key);
    return t && !this.movedSince(t.at, workspaceId, taskId) ? t.goal : undefined;
  }

  /** The stored entry, whether or not it counts. */
  get(key: string): LeadRank | undefined {
    return this.ranks.get(key);
  }

  /** Whether anything at all is stored for this key. */
  has(key: string): boolean {
    return this.ranks.has(key) || this.tags.has(key);
  }

  private movedSince(at: number, workspaceId: string, taskId?: string): boolean {
    const moved = taskId ? this.personMoves.get(`${workspaceId}:${taskId}`) : undefined;
    return moved !== undefined && moved > at;
  }

  /** When a person last moved this task, if ever. */
  personMovedAt(workspaceId: string, taskId: string): number | undefined {
    return this.personMoves.get(`${workspaceId}:${taskId}`);
  }

  private write(): void {
    const cutoff = this.now() - RANK_TTL_MS;
    for (const [key, r] of this.ranks) if (r.at < cutoff) this.ranks.delete(key);
    for (const [key, t] of this.tags) if (t.at < cutoff) this.tags.delete(key);
    for (const [key, at] of this.personMoves) if (at < cutoff) this.personMoves.delete(key);
    const out: Stored = {
      ranks: Object.fromEntries(this.ranks),
      tags: Object.fromEntries(this.tags),
      personMoves: Object.fromEntries(this.personMoves),
    };
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(out)}\n`);
    renameSync(tmp, this.path);
  }
}
