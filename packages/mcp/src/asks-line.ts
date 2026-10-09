/**
 * How the plan lead's batch of new asks reads to the session that ranks them.
 *
 * The server sends the plan board's lead one `workspace.new_asks` frame per
 * 10-minute window: every review item filed on another board in that window,
 * by board, row, queue key, headline and when it was filed
 * (`packages/server/src/ask-feed.ts`). The lead ranks what it should with
 * `rank_review_item`, passing the key as given. An ask that stops work says
 * so, with the stopped goal's title, because the lead's rank is what places
 * it on Home and the lead should know what the wait costs.
 *
 * Kept out of channel-messages.ts for the reason coach-line.ts is: the
 * wording is a decision, and this is where a test can read it.
 */

import { blocksLine } from '@claude-workspaces/core/review-blocks';

export interface AsksPayload {
  from?: number;
  to?: number;
  items?: AskItem[];
  more?: number;
}

export interface AskItem {
  workspaceId?: string;
  board?: string;
  row?: { kind?: string; taskId?: string; docId?: string };
  key?: string;
  headline?: string;
  createdAt?: number;
  stops?: { what?: string; goal?: string };
}

function clock(at: number | undefined, timeZone?: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '?';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

const rowOf = (row: AskItem['row']): string =>
  row?.taskId ? `task ${row.taskId}` : row?.docId ? `doc ${row.docId}` : 'row ?';

/** `- 14:05 Harborlight, task t-1: "headline" (key …)`, or null for a broken item. */
function itemLine(i: AskItem, timeZone?: string): string | null {
  if (!i.key || !i.headline) return null;
  const board = i.board ?? i.workspaceId ?? '?';
  const what = i.stops?.what;
  const stops = what ? ` ${blocksLine({ blocks: { what } }, i.stops?.goal)}.` : '';
  return `- ${clock(i.createdAt, timeZone)} ${board}, ${rowOf(i.row)}: "${i.headline}" (key ${i.key})${stops}`;
}

/** The line for one `workspace.new_asks` frame, or null when it carries nothing. */
export function asksLine(p: AsksPayload, timeZone?: string): string | null {
  const lines = (p.items ?? []).flatMap((i) => itemLine(i, timeZone) ?? []);
  if (lines.length === 0) return null;
  const more = p.more ? `\n(${p.more} more in this window, not listed.)` : '';
  const head = `[workspace.new_asks ${clock(p.from, timeZone)}–${clock(p.to, timeZone)}] ${lines.length} new ask${lines.length === 1 ? '' : 's'} on other boards. Rank any that this week's goals put ahead of the plan order, and file each under its goal, with rank_review_item(key, rank, goal):`;
  return `${head}\n${lines.join('\n')}${more}`;
}
