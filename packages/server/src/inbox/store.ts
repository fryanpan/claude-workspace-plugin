/**
 * The owner's inbox rows: one per message thread, keyed by the source's
 * thread id, in `<dataDir>/inbox/rows.json` (mode 600).
 *
 * Nothing here deletes. A row is retired (`answered`, `dismissed`), snoozed
 * until a time, reopened or undone, and every move is a `history` entry that
 * is never trimmed. A row retired for thirty days gets `archivedAt` and
 * leaves the live list; it stays in the file.
 *
 * Two writers, and they never share a verb:
 *  - the reader, through `post` — content, and the two state moves a pass
 *    can see (Bryan replied in the app; a new message arrived);
 *  - Bryan, through `act` — snooze, dismiss, remove, mark answered, reopen, undo —
 *    and through `markSent`, once his Send from the page has gone out.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { INBOX_DIRNAME } from './config.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import {
  ARCHIVE_AFTER_MS,
  type DismissReason,
  type InboxHistoryEntry,
  type InboxRow,
  type InboxRowInput,
  type InboxState,
  MAX_OPEN_ROWS,
  MAX_SNOOZE_MS,
  type SendChannel,
} from './types.ts';

interface RowsFile {
  version: 1;
  rows: InboxRow[];
  /** When the last pass posted, and its run id: the header's "Last checked". */
  lastPass?: { at: number; pass: string };
}

export type OwnerAction =
  | { kind: 'snooze'; until: number }
  | { kind: 'dismiss'; reason: DismissReason }
  /** Bryan's Remove: dismissed with no reason, so a new message brings it back. */
  | { kind: 'remove' }
  | { kind: 'answer' }
  | { kind: 'reopen' }
  | { kind: 'undo' };

export type ActResult =
  | { ok: true; row: InboxRow }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface PostResult {
  ok: true;
  ids: string[];
  created: number;
  updated: number;
}

const newRowId = (): string =>
  `ib-${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12)}`;

const isRetired = (s: InboxState): boolean => s === 'answered' || s === 'dismissed';

/** A new message brings back a row Bryan answered or removed. One he
 *  dismissed with a reason (spam, handled elsewhere) stays dismissed. */
const reopensOnNewMessage = (row: InboxRow): boolean =>
  row.state === 'answered' || (row.state === 'dismissed' && row.dismissReason === undefined);

export class InboxStore {
  private readonly path: string;
  private readonly now: () => number;
  private file: RowsFile;
  readonly loadError: string | null;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.path = join(dataDir, INBOX_DIRNAME, 'rows.json');
    this.now = now;
    const read = readJsonFile<RowsFile>(this.path, { version: 1, rows: [] }, now());
    const rows = Array.isArray(read.value?.rows) ? read.value.rows : [];
    this.file = {
      version: 1,
      rows,
      ...(read.value?.lastPass ? { lastPass: read.value.lastPass } : {}),
    };
    this.loadError = read.error;
  }

  private save(): void {
    writeJsonFile(this.path, this.file);
  }

  private move(
    row: InboxRow,
    to: InboxState,
    by: InboxHistoryEntry['by'],
    at: number,
    extra: Partial<InboxHistoryEntry> = {},
  ): void {
    row.history.push({ at, from: row.state, to, by, ...extra });
    row.state = to;
    if (to === 'snoozed' && extra.snoozedUntil !== undefined) row.snoozedUntil = extra.snoozedUntil;
    else row.snoozedUntil = undefined;
    if (to === 'dismissed' && extra.dismissReason) row.dismissReason = extra.dismissReason;
    else row.dismissReason = undefined;
    if (!isRetired(to)) row.archivedAt = undefined;
  }

  /**
   * Snoozes that have ended come back open, and rows retired for thirty days
   * are archived. Run before every read and write, so the file only ever
   * changes when somebody asks, and a snooze ends on time whoever asks.
   */
  private sweep(): void {
    const at = this.now();
    let changed = false;
    for (const row of this.file.rows) {
      if (row.state === 'snoozed' && (row.snoozedUntil ?? 0) <= at) {
        this.move(row, 'open', 'owner', at, { why: 'snooze-ended' });
        changed = true;
      }
      const retiredAt = row.history.at(-1)?.at ?? row.firstSeenAt;
      if (
        isRetired(row.state) &&
        row.archivedAt === undefined &&
        at - retiredAt >= ARCHIVE_AFTER_MS
      ) {
        row.archivedAt = at;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Every row not archived, in file order. */
  list(): InboxRow[] {
    this.sweep();
    return this.file.rows.filter((r) => r.archivedAt === undefined);
  }

  get(id: string): InboxRow | undefined {
    this.sweep();
    return this.file.rows.find((r) => r.id === id);
  }

  lastPass(): { at: number; pass: string } | undefined {
    return this.file.lastPass;
  }

  /** Counts only, for a stall check: never a purpose, a sender or a body. */
  counts(): { open: number; snoozed: number } {
    const rows = this.list();
    return {
      open: rows.filter((r) => r.state === 'open').length,
      snoozed: rows.filter((r) => r.state === 'snoozed').length,
    };
  }

  /**
   * Upsert a pass's rows by `dedupeKey`, or refuse the whole pass when it
   * would leave more than `MAX_OPEN_ROWS` open.
   */
  post(
    rows: readonly InboxRowInput[],
    pass: string,
  ): PostResult | { ok: false; error: 'too-many-open' } {
    this.sweep();
    const at = this.now();
    const byKey = new Map(this.file.rows.map((r) => [r.dedupeKey, r]));
    const opening = new Set<string>();
    for (const input of rows) {
      if (!byKey.has(input.dedupeKey) && !input.lastFromOwner) opening.add(input.dedupeKey);
    }
    const open = this.file.rows.filter((r) => r.state === 'open').length;
    if (open + opening.size > MAX_OPEN_ROWS) return { ok: false, error: 'too-many-open' };

    let created = 0;
    let updated = 0;
    const ids: string[] = [];
    for (const input of rows) {
      const existing = byKey.get(input.dedupeKey);
      if (!existing) {
        const row: InboxRow = {
          ...input,
          id: newRowId(),
          state: 'open',
          history: [],
          firstSeenAt: at,
          lastSeenAt: at,
          pass,
        };
        if (input.lastFromOwner)
          this.move(row, 'answered', 'reader', at, { why: 'replied-in-app' });
        this.file.rows.push(row);
        byKey.set(row.dedupeKey, row);
        ids.push(row.id);
        created += 1;
        continue;
      }
      const rose = input.messageCount > existing.messageCount;
      Object.assign(existing, input, { lastSeenAt: at, pass });
      if (input.stated === undefined) existing.stated = undefined;
      if (input.lastFromOwner && (existing.state === 'open' || existing.state === 'snoozed')) {
        this.move(existing, 'answered', 'reader', at, { why: 'replied-in-app' });
      } else if (!input.lastFromOwner && rose && reopensOnNewMessage(existing)) {
        this.move(existing, 'open', 'reader', at, { why: 'new-message' });
      }
      ids.push(existing.id);
      updated += 1;
    }
    this.file.lastPass = { at, pass };
    this.save();
    return { ok: true, ids, created, updated };
  }

  /**
   * Bryan's Send went out: the row is answered `by: owner-send`, with the
   * channel and the source's id for the message. The send has already
   * happened, so a row snoozed meanwhile is answered too; one a pass has
   * already answered keeps that entry and gains none.
   */
  markSent(id: string, sent: { channel: SendChannel; upstreamId: string }): InboxRow | undefined {
    this.sweep();
    const row = this.file.rows.find((r) => r.id === id);
    if (!row) return undefined;
    if (isRetired(row.state)) return row;
    this.move(row, 'answered', 'owner-send', this.now(), sent);
    this.save();
    return row;
  }

  /** Bryan's tap on one row. */
  act(id: string, action: OwnerAction): ActResult {
    this.sweep();
    const row = this.file.rows.find((r) => r.id === id);
    if (!row) return { ok: false, status: 404, error: 'not-found' };
    const at = this.now();
    switch (action.kind) {
      case 'snooze': {
        const until = action.until;
        if (!Number.isSafeInteger(until) || until <= at || until > at + MAX_SNOOZE_MS) {
          return { ok: false, status: 400, error: 'snooze-time' };
        }
        if (row.state !== 'open' && row.state !== 'snoozed') {
          return { ok: false, status: 409, error: 'not-open' };
        }
        this.move(row, 'snoozed', 'owner', at, { snoozedUntil: until });
        break;
      }
      case 'dismiss':
      case 'remove':
      case 'answer': {
        if (isRetired(row.state)) return { ok: false, status: 409, error: 'already-retired' };
        if (action.kind === 'dismiss') {
          this.move(row, 'dismissed', 'owner', at, { dismissReason: action.reason });
        } else if (action.kind === 'remove') this.move(row, 'dismissed', 'owner', at);
        else this.move(row, 'answered', 'owner', at);
        break;
      }
      case 'reopen': {
        if (row.state === 'open') return { ok: false, status: 409, error: 'already-open' };
        this.move(row, 'open', 'owner', at);
        break;
      }
      case 'undo': {
        const last = row.history.at(-1);
        if (!last || last.by !== 'owner' || last.why !== undefined) {
          return { ok: false, status: 409, error: 'nothing-to-undo' };
        }
        // What the row looked like before: the details of the entry that
        // last put it in that state.
        const before = [...row.history.slice(0, -1)].reverse().find((h) => h.to === last.from);
        const extra: Partial<InboxHistoryEntry> = { why: 'undo' };
        if (last.from === 'snoozed' && before?.snoozedUntil !== undefined) {
          extra.snoozedUntil = before.snoozedUntil;
        }
        if (last.from === 'dismissed' && before?.dismissReason) {
          extra.dismissReason = before.dismissReason;
        }
        this.move(row, last.from, 'owner', at, extra);
        break;
      }
    }
    this.save();
    // An undo back into a snooze that has already ended returns it at once.
    this.sweep();
    return { ok: true, row };
  }
}
