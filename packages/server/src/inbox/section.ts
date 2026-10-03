/**
 * Incoming Messages on the front page: the server-rendered section.
 *
 * Approved mock, round 3 (2026-10-01). What it keeps, and what is easy to
 * undo by accident:
 *
 *  - **A line is the reader's one-sentence purpose**, then a sub-line: the
 *    channel icon (plus the Slack workspace's label), the sender, the age and
 *    the goal. No buttons on the line and no reply-by label.
 *  - **Tap opens, a right swipe snoozes.** With a mouse a clock shows on
 *    hover; `b` does the same. All three open one "Snooze until…" modal.
 *    The behaviour is `landing-inbox.ts` in the app package; this file only
 *    draws what it acts on.
 *  - **At most five lines show**, then "N more", so the projects below stay
 *    in view at 1180x820.
 *  - **A line Bryan answered with Send stays where it was**, struck through
 *    and marked "clears at the next check", until the next pass.
 *  - **Remove (`e`) folds a line into "Removed"**, beside the snoozed fold,
 *    with "Bring back". The key list is a modal behind `?` and takes no
 *    space here.
 *
 * Only Bryan's own signed-in session gets this HTML (the caller decides);
 * every reader-written string goes through `escapeHtml`, and the message
 * text is not here at all — the page fetches it when a line opens.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { InboxConfig } from './config.ts';
import { type RankContext, rankRows } from './rank.ts';
import type { InboxGoalRef, InboxRow } from './types.ts';

export const INBOX_VISIBLE_LINES = 5;

export interface InboxSectionInput extends RankContext {
  rows: readonly InboxRow[];
  config: InboxConfig;
  goalTitle: (goal: InboxGoalRef) => string | undefined;
  lastPassAt: number | undefined;
  now: number;
}

const ICON: Record<string, string> = {
  mail: '<path d="M2.5 4.5h11v7h-11z"/><path d="m2.5 4.5 5.5 4.5 5.5-4.5"/>',
  chat: '<path d="M3 3.5h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
};

export const icon = (name: string): string =>
  `<svg class="inbox-icon" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/** "25m", "3h", "2d" — the mock's spelling. */
export function ageText(ts: number, now: number): string {
  const min = Math.max(0, Math.floor((now - ts) / 60_000));
  if (min < 60) return `${Math.max(1, min)}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (24 * 60))}d`;
}

/** The server's own wording of a time; the page rewrites it in the
 *  viewer's time zone from `data-at`. */
const clockText = (at: number): string =>
  new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const whenText = (at: number): string =>
  new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Where the message came from, as the page names it. */
export function channelName(row: InboxRow, config: InboxConfig): string {
  const ws = config.workspaces.get(row.workspace);
  if (row.source === 'gmail') return 'Email';
  if (row.source === 'messages') return 'Texts';
  return `Slack ${ws?.label ?? ''}`.trim();
}

function where(row: InboxRow, config: InboxConfig): string {
  const label = config.workspaces.get(row.workspace)?.label ?? '';
  const glyph = row.source === 'gmail' ? 'mail' : row.source === 'messages' ? 'phone' : 'chat';
  return `<span class="inbox-where" title="${escapeHtml(channelName(row, config))}">${icon(glyph)}${
    label ? `<span>${escapeHtml(label)}</span>` : ''
  }</span>`;
}

function subLine(row: InboxRow, input: InboxSectionInput): string {
  const goal = row.goal ? input.goalTitle(row.goal) : undefined;
  const label = input.config.workspaces.get(row.workspace)?.label ?? '';
  const parts = [
    `${escapeHtml(row.senderLabel)}${row.senderKnown ? '' : ' (new)'}`,
    `${ageText(row.receivedAt, input.now)} ago`,
    ...(goal ? [escapeHtml(goal)] : []),
  ];
  return `<span class="board-review-row-sub">${where(row, input.config)}${label ? ' · ' : ' '}${parts.join(' · ')}</span>`;
}

function openLine(row: InboxRow, n: number, input: InboxSectionInput): string {
  const link = row.link ? ` data-link="${escapeHtml(row.link)}"` : '';
  return `<div class="inbox-row" data-row="${escapeHtml(row.id)}" data-channel="${escapeHtml(
    channelName(row, input.config),
  )}" data-sender="${escapeHtml(row.senderLabel)}"${link}${n >= INBOX_VISIBLE_LINES ? ' hidden' : ''}><div class="inbox-line"><div class="inbox-swipe-under">${icon(
    'clock',
  )}<span>Snooze</span></div><button type="button" class="board-review-row" aria-expanded="false"><span class="board-review-row-title">${escapeHtml(
    row.purpose,
  )}</span>${subLine(row, input)}</button><div class="inbox-line-acts"><button type="button" class="inbox-snooze-btn" data-act="snooze" aria-label="Snooze" title="Snooze (b)">${icon(
    'clock',
  )}</button></div></div></div>`;
}

/** When Bryan's Send from the page answered this row, if no pass has run
 *  since: the line stays, struck through, until one does. */
export function sentAt(row: InboxRow, lastPassAt: number | undefined): number | undefined {
  if (row.state !== 'answered') return undefined;
  const last = row.history.at(-1);
  if (last?.by !== 'owner-send') return undefined;
  return lastPassAt === undefined || last.at > lastPassAt ? last.at : undefined;
}

function sentLine(row: InboxRow, at: number, n: number, input: InboxSectionInput): string {
  return `<div class="inbox-row inbox-cleared" data-row="${escapeHtml(row.id)}"${n >= INBOX_VISIBLE_LINES ? ' hidden' : ''}><div class="board-review-row"><span class="board-review-row-title">${escapeHtml(
    row.purpose,
  )}</span><span class="board-review-row-sub">You replied on ${escapeHtml(
    channelName(row, input.config),
  )} at <time data-at="${at}" data-clock>${escapeHtml(clockText(at))}</time> · clears at the next check</span></div></div>`;
}

function snoozedLine(row: InboxRow): string {
  const until = row.snoozedUntil ?? 0;
  return `<div class="inbox-row inbox-row-folded" data-row="${escapeHtml(row.id)}"><div class="board-review-row"><span class="board-review-row-title">${escapeHtml(
    row.purpose,
  )}</span><span class="board-review-row-sub">${escapeHtml(row.senderLabel)} · snoozed until <time data-at="${until}">${escapeHtml(
    whenText(until),
  )}</time></span><button type="button" class="inbox-undo" data-act="reopen">Bring back now</button></div></div>`;
}

/** A line Bryan removed, in the Removed fold: back with one tap. */
function removedLine(row: InboxRow): string {
  const at = row.history.at(-1)?.at ?? row.lastSeenAt;
  return `<div class="inbox-row inbox-row-folded" data-row="${escapeHtml(row.id)}"><div class="board-review-row"><span class="board-review-row-title">${escapeHtml(
    row.purpose,
  )}</span><span class="board-review-row-sub">${escapeHtml(row.senderLabel)} · removed <time data-at="${at}">${escapeHtml(
    whenText(at),
  )}</time></span><button type="button" class="inbox-undo" data-act="reopen">Bring back</button></div></div>`;
}

/** A folded list under a one-line toggle: the snoozed lines, the removed ones. */
function fold(kind: 'snoozed' | 'removed', lines: string[]): string {
  if (lines.length === 0) return '';
  return `<button type="button" class="inbox-fold-line" data-fold="${kind}" aria-expanded="false">Show ${lines.length} ${kind}</button><div class="inbox-fold" data-fold-body="${kind}" hidden>${lines.join('')}</div>`;
}

/** The section, or nothing when the inbox has never been set up. */
export function renderInboxSection(input: InboxSectionInput): string {
  const { rows, config } = input;
  if (rows.length === 0 && config.readerAgentId === null && input.lastPassAt === undefined) {
    return '';
  }
  const sent = new Map<string, number>();
  for (const r of rows) {
    const at = sentAt(r, input.lastPassAt);
    if (at !== undefined) sent.set(r.id, at);
  }
  const shown = rankRows(
    rows.filter((r) => r.state === 'open' || sent.has(r.id)),
    input,
  );
  const open = shown.filter((r) => r.state === 'open');
  const snoozed = rows
    .filter((r) => r.state === 'snoozed')
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  const pass =
    input.lastPassAt === undefined
      ? 'Not checked yet'
      : `Last checked at <time data-at="${input.lastPassAt}" data-clock>${escapeHtml(clockText(input.lastPassAt))}</time>`;
  const lines =
    shown.length === 0
      ? '<p class="board-home-quiet">Nothing in your messages needs you right now.</p>'
      : shown
          .map((r, i) => {
            const at = sent.get(r.id);
            return at === undefined ? openLine(r, i, input) : sentLine(r, at, i, input);
          })
          .join('');
  const more =
    shown.length > INBOX_VISIBLE_LINES
      ? `<button type="button" class="inbox-more" data-more>${shown.length - INBOX_VISIBLE_LINES} more</button>`
      : '';
  // Removed by Bryan's tap only: one a pass retired is not his to bring back.
  const removed = rows
    .filter((r) => r.state === 'dismissed' && r.dismissReason === undefined)
    .sort((a, b) => (b.history.at(-1)?.at ?? 0) - (a.history.at(-1)?.at ?? 0));
  const folds =
    fold('snoozed', snoozed.map(snoozedLine)) + fold('removed', removed.map(removedLine));
  return `<section id="inbox" class="inbox-front" data-module="inbox" aria-labelledby="inbox-h" tabindex="-1"><div class="inbox-head"><h2 id="inbox-h" class="board-home-heading">Incoming Messages</h2><span class="inbox-pass">${pass}</span></div><div class="inbox-rows">${lines}${more}</div>${folds}<div class="inbox-foot"><span class="inbox-pass inbox-count">${open.length} open</span></div></section>`;
}
