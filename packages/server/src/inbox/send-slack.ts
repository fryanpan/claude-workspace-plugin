/**
 * Bryan's reply on Slack: a message in the same thread, posted with his own
 * user token for the row's workspace (`send-keychain.ts`).
 *
 * Before the first post with a token, `auth.test` says which team it
 * belongs to, and the post goes ahead only when that team's URL is the host
 * the inbox config names for the row's workspace. A token stored under the
 * wrong workspace key therefore refuses rather than posting into another
 * team. The answer is kept per token (by its hash) for the life of the
 * process, so a replaced token is asked again.
 *
 * The text is posted as typed. `&`, `<` and `>` are escaped as Slack asks,
 * so `<@U…>` or `<!channel>` Bryan types shows as those characters rather
 * than becoming a mention, and nothing is added to it.
 */
import { createHash } from 'node:crypto';
import type { FetchLike, SendOutcome } from './send-gmail.ts';
import { SLACK_SEND_SERVICE, type SendKeychain } from './send-keychain.ts';

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

  return {
    ready: (workspace) => deps.keychain.has(SLACK_SEND_SERVICE, workspace),
    async send(target, text) {
      const token = deps.keychain.read(SLACK_SEND_SERVICE, target.workspace);
      if (!token) return { ok: false, error: 'slack: no token' };
      const key = createHash('sha256').update(token).digest('hex');
      if (!teamUrl.has(key)) {
        const who = await call('auth.test', token, {});
        if (who?.ok !== true || typeof who.url !== 'string') {
          return { ok: false, error: 'slack: token refused' };
        }
        teamUrl.set(key, who.url);
      }
      if (teamUrl.get(key) !== `https://${target.host}.slack.com/`) {
        return { ok: false, error: 'slack: token is for another workspace' };
      }
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
