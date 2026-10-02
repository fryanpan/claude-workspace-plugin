/**
 * The one link a row may carry, rebuilt from parts the server checked.
 *
 * The input string is never stored or echoed. Each form below is parsed,
 * each part is checked on its own, and the stored URL is assembled from
 * those parts, so anything the allowlist does not name — a userinfo, a port,
 * a query parameter, a fragment, another host — cannot survive into the
 * page even as a suffix.
 *
 *  - Email: `https://mail.google.com/mail/u/<0-9>/#all|inbox/<16 hex>`.
 *  - Slack: `https://<host>.slack.com/archives/<C|D|G…>/p<16 digits>`, with
 *    an optional `?thread_ts=<10>.<6>`, where `<host>` is the one the config
 *    names for the row's own workspace.
 *  - Texts: `sms:+<E.164>` or `imessage:+<E.164>`, no query at all: a
 *    `body=` would put words the attacker chose into Bryan's reply.
 */
import type { InboxWorkspace } from './config.ts';

export const LINK_MAX = 300;

export type LinkVerdict = { ok: true; link: string | null } | { ok: false; reason: string };

const E164 = /^\+[1-9][0-9]{6,14}$/;

function gmail(url: URL): string | null {
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return null;
  if (url.username || url.password || url.port || url.search) return null;
  const path = url.pathname.match(/^\/mail\/u\/([0-9])\/$/);
  const frag = url.hash.match(/^#(all|inbox)\/([0-9a-f]{16})$/);
  if (!path || !frag) return null;
  return `https://mail.google.com/mail/u/${path[1]}/#${frag[1]}/${frag[2]}`;
}

function slack(url: URL, host: string): string | null {
  if (url.protocol !== 'https:' || url.hostname !== `${host}.slack.com`) return null;
  if (url.username || url.password || url.port || url.hash) return null;
  const path = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]{8,12})\/p([0-9]{16})$/);
  if (!path) return null;
  const base = `https://${host}.slack.com/archives/${path[1]}/p${path[2]}`;
  if (url.search === '') return base;
  const keys = [...url.searchParams.keys()];
  const ts = url.searchParams.get('thread_ts') ?? '';
  if (keys.length !== 1 || keys[0] !== 'thread_ts' || !/^[0-9]{10}\.[0-9]{6}$/.test(ts)) {
    return null;
  }
  return `${base}?thread_ts=${ts}`;
}

function texts(raw: string): string | null {
  const m = raw.match(/^(sms|imessage):(\+[0-9]+)$/);
  if (!m?.[2] || !E164.test(m[2])) return null;
  return `${m[1]}:${m[2]}`;
}

/** The stored link for a row in `workspace`, or why the input was refused.
 *  `null` in, `null` out: a group text has no link. */
export function rebuildLink(raw: unknown, workspace: InboxWorkspace): LinkVerdict {
  if (raw === null) return { ok: true, link: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'link is not text' };
  if (raw.length === 0 || raw.length > LINK_MAX) return { ok: false, reason: 'link length' };
  // Whitespace and controls never belong in any allowed form, and URL parsing
  // would quietly strip some of them.
  if (/[\s\p{Cc}\p{Cf}]/u.test(raw)) return { ok: false, reason: 'link has whitespace' };
  if (workspace.source === 'messages') {
    const link = texts(raw);
    return link ? { ok: true, link } : { ok: false, reason: 'link is not an allowed form' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'link is not a URL' };
  }
  const link =
    workspace.source === 'gmail'
      ? gmail(url)
      : workspace.slackHost
        ? slack(url, workspace.slackHost)
        : null;
  return link ? { ok: true, link } : { ok: false, reason: 'link is not an allowed form' };
}
