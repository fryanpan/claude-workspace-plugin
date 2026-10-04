/**
 * Bryan's reply on Slack: a message in the same thread, posted with his own
 * user token for the row's workspace (`send-keychain.ts`).
 *
 * The tokens tried, in order: the raw entry under the row's workspace key,
 * then each token on the secret card. Before a token is used, `auth.test`
 * says which team it belongs to, and the post goes ahead only with the first
 * token whose team URL is the host the inbox config names for the row's
 * workspace. A token for any other team is never posted with, so a card
 * token Bryan saved for one team cannot reach another, and a token stored
 * under the wrong workspace key refuses rather than posting into another
 * team. The answer is kept per token (by its hash) for the life of the
 * process, so a replaced token is asked again and a known one is not.
 *
 * `ready` reads no value. A raw entry for the workspace, or any card token,
 * makes it true; which team a card token is for is only known after
 * `auth.test`, so for card tokens it means "may be ready" and the send says
 * which it was.
 *
 * The text is posted as typed. `&`, `<` and `>` are escaped as Slack asks,
 * so `<@U…>` or `<!channel>` Bryan types shows as those characters rather
 * than becoming a mention, and nothing is added to it.
 */
import { createHash } from 'node:crypto';
import type { FetchLike, SendOutcome } from './send-gmail.ts';
import {
  SLACK_CARD_TOKENS,
  SLACK_SEND_SERVICE,
  type SendKeychain,
  cardHas,
  cardRead,
} from './send-keychain.ts';

const API = 'https://slack.com/api';

export interface SlackTarget {
  workspace: string;
  host: string;
  channelId: string;
  threadTs: string;
}

export interface SlackSender {
  ready(workspace: string): boolean;
  send(target: SlackTarget, text: string): Promise<SendOutcome>;
}

export const slackEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackSender(deps: { keychain: SendKeychain; fetch: FetchLike }): SlackSender {
  const teamUrl = new Map<string, string>();

  async function call(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const res = await deps.fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  }

  /** Which team a token is for, asked once per token; null when refused. */
  async function teamOf(token: string): Promise<string | null> {
    const key = createHash('sha256').update(token).digest('hex');
    if (!teamUrl.has(key)) {
      const who = await call('auth.test', token, {});
      if (who?.ok !== true || typeof who.url !== 'string') return null;
      teamUrl.set(key, who.url);
    }
    return teamUrl.get(key) ?? null;
  }

  /** The token whose team is `host`, read lazily so a raw match reads no card. */
  async function tokenFor(target: SlackTarget): Promise<string | { error: string }> {
    const sources = [
      () => deps.keychain.read(SLACK_SEND_SERVICE, target.workspace),
      ...SLACK_CARD_TOKENS.map((n) => () => cardRead(deps.keychain, n)),
    ];
    let error = 'slack: no token';
    for (const source of sources) {
      const token = source();
      if (!token) continue;
      const url = await teamOf(token);
      if (url === `https://${target.host}.slack.com/`) return token;
      if (url) error = 'slack: token is for another workspace';
      else if (error === 'slack: no token') error = 'slack: token refused';
    }
    return { error };
  }

  return {
    ready: (workspace) =>
      deps.keychain.has(SLACK_SEND_SERVICE, workspace) ||
      SLACK_CARD_TOKENS.some((n) => cardHas(deps.keychain, n)),
    async send(target, text) {
      const token = await tokenFor(target);
      if (typeof token !== 'string') return { ok: false, error: token.error };
      const out = await call('chat.postMessage', token, {
        channel: target.channelId,
        thread_ts: target.threadTs,
        text: slackEscape(text),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (out?.ok !== true || typeof out.ts !== 'string') {
        const code = typeof out?.error === 'string' ? out.error.replace(/[^a-z_]/g, '') : 'http';
        return { ok: false, error: `slack: ${code.slice(0, 40)}` };
      }
      return { ok: true, upstreamId: out.ts };
    },
  };
}
