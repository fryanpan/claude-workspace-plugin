/**
 * Bryan's reply on Email: a message in the same Gmail thread, to the
 * original sender only.
 *
 * Three calls, all with Bryan's own OAuth grant (`send-keychain.ts`):
 *
 *  1. a refresh-token exchange for an access token, kept until it expires;
 *  2. the thread's headers (`format=metadata`, so no message text is read):
 *     the newest message Bryan did not send gives the recipient, the subject
 *     and the ids that thread the reply;
 *  3. the send, with `threadId` so Gmail files it in the thread.
 *
 * The recipient is the newest inbound message's `From`, one address and no
 * display name. Reply-To, Cc and every other recipient are ignored: no
 * reply-all in this version. Every header value that came from the thread
 * is checked or cleaned before it is written, so a subject carrying a line
 * break cannot add a header. The text goes as typed, base64-encoded, with no
 * signature or quote added.
 *
 * Errors name the step and the HTTP status, never a response body: a body
 * from Google can echo the request.
 */
import { GMAIL_ACCOUNTS, GMAIL_SEND_SERVICE, type SendKeychain } from './send-keychain.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type SendOutcome = { ok: true; upstreamId: string } | { ok: false; error: string };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const THREAD_ID = /^[0-9a-f]{16}$/;
/** RFC 5322 msg-id, without the obsolete forms: no spaces, no angle brackets inside. */
const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;
const ADDRESS = /^[^\s@<>,;:"()[\]\\]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const MAX_REFERENCES = 20;

interface GmailHeader {
  name?: unknown;
  value?: unknown;
}
interface GmailMessage {
  labelIds?: unknown;
  payload?: { headers?: GmailHeader[] };
}

const header = (m: GmailMessage, name: string): string => {
  const h = m.payload?.headers?.find(
    (x) => typeof x.name === 'string' && x.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof h?.value === 'string' ? h.value : '';
};

/** The one address in a From header, or null when there is not exactly one. */
export function singleAddress(from: string): string | null {
  const bracketed = [...from.matchAll(/<([^<>]*)>/g)].map((m) => m[1] ?? '');
  const candidate = bracketed.length === 1 ? bracketed[0] : bracketed.length === 0 ? from : null;
  const addr = candidate?.trim() ?? '';
  return ADDRESS.test(addr) ? addr : null;
}

/** A header value that came from outside: one line, no controls, ASCII or
 *  RFC 2047-encoded. */
export function subjectHeader(original: string): string {
  const flat = original
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = /^re:/i.test(flat) ? flat : `Re: ${flat}`.trim();
  const clipped = [...base].slice(0, 200).join('');
  if (/^[\x20-\x7e]*$/.test(clipped)) return clipped;
  return `=?UTF-8?B?${Buffer.from(clipped, 'utf8').toString('base64')}?=`;
}

/** The raw RFC 5322 message, base64url-encoded as the send call takes it. */
export function buildReply(input: {
  to: string;
  subject: string;
  messageId: string;
  references: string;
  text: string;
}): string {
  const msgId = MSG_ID.test(input.messageId.trim()) ? input.messageId.trim() : '';
  const refs = input.references
    .split(/\s+/)
    .filter((r) => MSG_ID.test(r))
    .slice(-MAX_REFERENCES);
  if (msgId && !refs.includes(msgId)) refs.push(msgId);
  const body = Buffer.from(input.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  const lines = [
    `To: ${input.to}`,
    `Subject: ${subjectHeader(input.subject)}`,
    ...(msgId ? [`In-Reply-To: ${msgId}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export interface GmailSender {
  ready(): boolean;
  send(threadId: string, text: string): Promise<SendOutcome>;
}

export function gmailSender(deps: {
  keychain: SendKeychain;
  fetch: FetchLike;
  now?: () => number;
}): GmailSender {
  const now = deps.now ?? Date.now;
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string | null> {
    if (token && token.until > now()) return token.value;
    const [clientId, clientSecret, refreshToken] = GMAIL_ACCOUNTS.map((a) =>
      deps.keychain.read(GMAIL_SEND_SERVICE, a),
    );
    if (!clientId || !clientSecret || !refreshToken) return null;
    const res = await deps.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string') return null;
    const life = typeof data.expires_in === 'number' ? data.expires_in : 600;
    // A minute's margin, so a token is never used in its last seconds.
    token = { value: data.access_token, until: now() + Math.max(0, life - 60) * 1000 };
    return token.value;
  }

  return {
    ready: () => GMAIL_ACCOUNTS.every((a) => deps.keychain.has(GMAIL_SEND_SERVICE, a)),
    async send(threadId, text) {
      if (!THREAD_ID.test(threadId)) return { ok: false, error: 'gmail: thread id' };
      const access = await accessToken();
      if (!access) return { ok: false, error: 'gmail: sign-in refused' };
      const auth = { authorization: `Bearer ${access}` };
      const params = ['From', 'Subject', 'Message-ID', 'References']
        .map((h) => `metadataHeaders=${h}`)
        .join('&');
      const read = await deps.fetch(`${API}/threads/${threadId}?format=metadata&${params}`, {
        headers: auth,
      });
      if (!read.ok) return { ok: false, error: `gmail: thread read ${read.status}` };
      const thread = (await read.json()) as { messages?: GmailMessage[] };
      const inbound = (thread.messages ?? []).filter((m) => {
        const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
        return !labels.includes('SENT') && !labels.includes('DRAFT');
      });
      const last = inbound.at(-1);
      const to = last ? singleAddress(header(last, 'From')) : null;
      if (!last || !to) return { ok: false, error: 'gmail: no single sender to reply to' };
      const raw = buildReply({
        to,
        subject: header(last, 'Subject'),
        messageId: header(last, 'Message-ID'),
        references: header(last, 'References'),
        text,
      });
      const sent = await deps.fetch(`${API}/messages/send`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ raw, threadId }),
      });
      if (!sent.ok) return { ok: false, error: `gmail: send ${sent.status}` };
      const out = (await sent.json()) as { id?: unknown };
      return typeof out.id === 'string'
        ? { ok: true, upstreamId: out.id }
        : { ok: false, error: 'gmail: send returned no id' };
    },
  };
}
