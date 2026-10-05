/**
 * Incoming Messages: the row a reader session posts, one per message thread.
 *
 * The messages come from people outside the trust zone, so everything a
 * reader posts is hostile until `validate.ts` has passed it. The row is the
 * only thing the reader can write, which makes its shape and those checks
 * the whole security boundary. Design: the inbox-triage design doc on the
 * Workspaces board (schema round 2, page round 3).
 *
 * The message text itself (`body`) is never on a row. It lives in its own
 * file (`bodies.ts`), and one owner-only route reads it, so no agent can
 * read a message by reading a row.
 */

export type InboxSource = 'gmail' | 'slack' | 'messages';
export const INBOX_SOURCES: readonly InboxSource[] = ['gmail', 'slack', 'messages'];

export type AskKind = 'reply' | 'decision' | 'meeting' | 'intro' | 'fyi';
export const ASK_KINDS: readonly AskKind[] = ['reply', 'decision', 'meeting', 'intro', 'fyi'];

/** The reader's urgency guess. Used to rank, never shown. */
export type ReplyBy = 'today' | 'tomorrow' | 'this-week' | 'when-free';
export const REPLY_BY: readonly ReplyBy[] = ['today', 'tomorrow', 'this-week', 'when-free'];

/**
 * `answered` and `dismissed` retire a row; `snoozed` hides it until a time.
 * Nothing is ever deleted: a retired row stays in the file, and `archivedAt`
 * marks one retired for more than `ARCHIVE_AFTER_MS`.
 */
export type InboxState = 'open' | 'snoozed' | 'answered' | 'dismissed';

/** Why Bryan dismissed a row. A closed list, so no free text is stored. */
export type DismissReason = 'not-needed' | 'handled-elsewhere' | 'spam';
export const DISMISS_REASONS: readonly DismissReason[] = [
  'not-needed',
  'handled-elsewhere',
  'spam',
];

/** Who moved a row. `owner` is Bryan's tap; `reader` is a pass;
 *  `owner-send` is Bryan's Send from the page (`reply.ts`); `agent` is a
 *  poster taking a row off his list as handled elsewhere, named by
 *  `agentId` on the entry. */
export type InboxActor = 'owner' | 'reader' | 'owner-send' | 'agent';

/** The one reason a poster may dismiss a row with. */
export const AGENT_DISMISS_REASON: DismissReason = 'handled-elsewhere';

/** The channels the server sends on. Texts are sent by Bryan in Messages. */
export type SendChannel = 'gmail' | 'slack';

export interface InboxHistoryEntry {
  at: number;
  from: InboxState;
  to: InboxState;
  by: InboxActor;
  /** What the change was, when the states alone do not say: an undo, a
   *  snooze's return, a reopen by a new message. */
  why?: 'undo' | 'snooze-ended' | 'new-message' | 'replied-in-app';
  /** The snooze end or dismiss reason this change set, so an undo can put
   *  the row back exactly. */
  snoozedUntil?: number;
  dismissReason?: DismissReason;
  /** A Send from the page: where it went and the id the source gave it. */
  channel?: SendChannel;
  upstreamId?: string;
  /** An `agent` entry: the poster that dismissed the row. */
  agentId?: string;
}

export interface InboxGoalRef {
  workspaceId: string;
  goalId: string;
}

/** A row as the reader posts it, after validation. `body` is split off. */
export interface InboxRowInput {
  dedupeKey: string;
  source: InboxSource;
  /** The configured workspace the page shows: `email`, `texts`, or a Slack
   *  workspace named in the inbox config. */
  workspace: string;
  senderLabel: string;
  senderKey: string;
  senderKnown: boolean;
  purpose: string;
  askKind: AskKind;
  replyBy: ReplyBy;
  /** An ISO date the message names, `YYYY-MM-DD`. */
  stated?: string;
  goal: InboxGoalRef | null;
  /** Rebuilt by the server from an allowlisted form; never the input string. */
  link: string | null;
  receivedAt: number;
  messageCount: number;
  lastFromOwner: boolean;
}

export interface InboxRow extends InboxRowInput {
  /** `ib-` + 12 characters, minted on the first post of a `dedupeKey`. */
  id: string;
  state: InboxState;
  snoozedUntil?: number;
  dismissReason?: DismissReason;
  history: InboxHistoryEntry[];
  firstSeenAt: number;
  lastSeenAt: number;
  /** The run that last posted this row. */
  pass: string;
  archivedAt?: number;
}

/** How long a retired row stays in the live set before it is archived. */
export const ARCHIVE_AFTER_MS = 30 * 86_400_000;

/** At most this many rows in one post. */
export const MAX_ROWS_PER_POST = 40;
/** At most this many open rows at once; a post that would pass it is refused. */
export const MAX_OPEN_ROWS = 200;

/** The furthest ahead a snooze may be set. */
export const MAX_SNOOZE_MS = 366 * 86_400_000;
