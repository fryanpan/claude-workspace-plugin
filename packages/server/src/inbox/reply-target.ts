/**
 * Where Bryan's reply to a row goes, built from the stored row and the inbox
 * config, never from the request.
 *
 * The request to send carries only the words and a nonce. The thread, the
 * channel, the Slack team and the recipient all come from what the server
 * already holds: the row's `dedupeKey` and its rebuilt `link`, both checked
 * when the reader posted them, and the host the config names for the row's
 * workspace now. A row whose link names another host than the config does
 * today is refused, so editing the config cannot send an old row's reply to
 * a different team.
 *
 *  - Email: the Gmail thread id, the `dedupeKey` body when it is a Gmail id,
 *    else the id in the link. The recipient is read from the thread at send
 *    time (`send-gmail.ts`).
 *  - Slack: the channel and thread timestamp from the link, and the host.
 *  - Texts: none. The page opens Messages and Bryan sends it there.
 */
import type { InboxConfig } from './config.ts';
import type { InboxRow } from './types.ts';

export type ReplyTarget =
  | { channel: 'gmail'; threadId: string }
  | { channel: 'slack'; workspace: string; host: string; channelId: string; threadTs: string };

export type TargetVerdict =
  | { ok: true; target: ReplyTarget }
  | { ok: false; error: 'sent-in-messages' | 'no-destination' | 'destination-changed' };

const GMAIL_ID = /^[0-9a-f]{16}$/;
const GMAIL_LINK = /^https:\/\/mail\.google\.com\/mail\/u\/[0-9]\/#(?:all|inbox)\/([0-9a-f]{16})$/;
const SLACK_LINK =
  /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.slack\.com\/archives\/([CDG][A-Z0-9]{8,12})\/p([0-9]{10})([0-9]{6})(?:\?thread_ts=([0-9]{10}\.[0-9]{6}))?$/;

export function replyTargetFor(row: InboxRow, config: InboxConfig): TargetVerdict {
  const ws = config.workspaces.get(row.workspace);
  if (!ws || ws.source !== row.source) return { ok: false, error: 'destination-changed' };
  if (row.source === 'messages') return { ok: false, error: 'sent-in-messages' };
  if (row.source === 'gmail') {
    const key = row.dedupeKey.slice('gmail:'.length);
    const threadId = GMAIL_ID.test(key) ? key : row.link?.match(GMAIL_LINK)?.[1];
    return threadId
      ? { ok: true, target: { channel: 'gmail', threadId } }
      : { ok: false, error: 'no-destination' };
  }
  const m = row.link?.match(SLACK_LINK);
  if (!m) return { ok: false, error: 'no-destination' };
  const [, host, channelId, secs, micros, threadTs] = m;
  if (!ws.slackHost || host !== ws.slackHost) return { ok: false, error: 'destination-changed' };
  return {
    ok: true,
    target: {
      channel: 'slack',
      workspace: ws.key,
      host,
      channelId: channelId ?? '',
      // A reply inside a thread names the thread's first message; a message
      // that starts no thread is the thread.
      threadTs: threadTs ?? `${secs}.${micros}`,
    },
  };
}
