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

export interface LeadRank {
  rank: number;
  /** When it was set. */
  at: number;
  /** The agent that set it. */
  by: string;
}

interface Stored {
  ranks: Record<string, LeadRank>;
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
    if (!r) return undefined;
    const moved = taskId ? this.personMoves.get(`${workspaceId}:${taskId}`) : undefined;
    return moved !== undefined && moved > r.at ? undefined : r.rank;
  }

  /** The stored entry, whether or not it counts. */
  get(key: string): LeadRank | undefined {
    return this.ranks.get(key);
  }

  /** When a person last moved this task, if ever. */
  personMovedAt(workspaceId: string, taskId: string): number | undefined {
    return this.personMoves.get(`${workspaceId}:${taskId}`);
  }

  private write(): void {
    const cutoff = this.now() - RANK_TTL_MS;
    for (const [key, r] of this.ranks) if (r.at < cutoff) this.ranks.delete(key);
    for (const [key, at] of this.personMoves) if (at < cutoff) this.personMoves.delete(key);
    const out: Stored = {
      ranks: Object.fromEntries(this.ranks),
      personMoves: Object.fromEntries(this.personMoves),
    };
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(out)}\n`);
    renameSync(tmp, this.path);
  }
}
