/**
 * Send reading the credentials Bryan saved on a secret card: the values sit
 * BASE64 under `claude-workspaces-secret.<name>`, account
 * `claude-workspaces`, beside the older raw per-source entries. A fake
 * Keychain and a fake `fetch` stand in for both, so nothing here is real.
 */
import { describe, expect, it } from 'bun:test';
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';
import { gmailSender } from '../src/inbox/send-gmail.ts';
import {
  GMAIL_SEND_SERVICE,
  SLACK_SEND_SERVICE,
  type SendKeychain,
} from '../src/inbox/send-keychain.ts';
import { slackSender } from '../src/inbox/send-slack.ts';

const card = (name: string) => `${storedSecretService(name)}/${SECRET_ACCOUNT}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function fakeKeychain(values: Record<string, string>): SendKeychain & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    has: (s, a) => `${s}/${a}` in values,
    read: (s, a) => {
      reads.push(`${s}/${a}`);
      return values[`${s}/${a}`] ?? null;
    },
  };
}

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer(url, init)));
  };
  return { calls, fetch };
}

const bearer = (c: Call | undefined) =>
  (c?.init.headers as Record<string, string> | undefined)?.authorization;

const GMAIL_CARD = {
  [card('inbox-gmail-client-id')]: b64('card-client'),
  [card('inbox-gmail-client-secret')]: b64('card-secret'),
  [card('inbox-gmail-refresh-token')]: b64('card-refresh'),
};
const GMAIL_RAW = {
  [`${GMAIL_SEND_SERVICE}/client-id`]: 'raw-client',
  [`${GMAIL_SEND_SERVICE}/client-secret`]: 'raw-secret',
  [`${GMAIL_SEND_SERVICE}/refresh-token`]: 'raw-refresh',
};

const gmailAnswer = (url: string) => {
  if (url.includes('oauth2')) return { access_token: 'fake-access', expires_in: 3600 };
  if (url.includes('/threads/')) {
    return {
      messages: [
        {
          labelIds: ['INBOX'],
          payload: {
            headers: [
              { name: 'From', value: ['alice', 'riverbend.example'].join('@') },
              { name: 'Subject', value: 'Harborlight' },
            ],
          },
        },
      ],
    };
  }
  return { id: 'sent-1' };
};

describe('Gmail from the secret card', () => {
  it('signs in with the decoded card values and sends', async () => {
    const { calls, fetch } = fakeFetch(gmailAnswer);
    const kc = fakeKeychain({ ...GMAIL_CARD, ...GMAIL_RAW });
    const sender = gmailSender({ keychain: kc, fetch });
    expect(await sender.send('18c2f0a1b2c3d4e5', 'Hi')).toEqual({ ok: true, upstreamId: 'sent-1' });
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get('client_id')).toBe('card-client');
    expect(form.get('client_secret')).toBe('card-secret');
    expect(form.get('refresh_token')).toBe('card-refresh');
  });

  it('falls back to the raw entries as a set when the card is incomplete', async () => {
    const { [card('inbox-gmail-refresh-token')]: _, ...partial } = GMAIL_CARD;
    const { calls, fetch } = fakeFetch(gmailAnswer);
    const sender = gmailSender({ keychain: fakeKeychain({ ...partial, ...GMAIL_RAW }), fetch });
    expect(await sender.send('18c2f0a1b2c3d4e5', 'Hi')).toMatchObject({ ok: true });
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get('client_id')).toBe('raw-client');
    expect(form.get('refresh_token')).toBe('raw-refresh');
  });

  it('is ready from the card alone, and reads no value to say so', () => {
    const kc = fakeKeychain(GMAIL_CARD);
    expect(gmailSender({ keychain: kc, fetch: fakeFetch(() => ({})).fetch }).ready()).toBe(true);
    expect(kc.reads).toEqual([]);
    const { [card('inbox-gmail-client-id')]: _, ...two } = GMAIL_CARD;
    expect(
      gmailSender({ keychain: fakeKeychain(two), fetch: fakeFetch(() => ({})).fetch }).ready(),
    ).toBe(false);
  });
});

describe('Slack from the secret card', () => {
  const TEAMS: Record<string, string> = {
    'Bearer card-harbor': 'https://harborlight.slack.com/',
    'Bearer card-river': 'https://riverbend.slack.com/',
  };
  const slackAnswer = (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? '';
    if (url.endsWith('auth.test')) {
      return TEAMS[auth] ? { ok: true, url: TEAMS[auth] } : { ok: false, error: 'invalid_auth' };
    }
    return { ok: true, ts: '1727890001.000200' };
  };
  const CARD_TOKENS = {
    [card('inbox-slack-token-1')]: b64('card-river'),
    [card('inbox-slack-token-2')]: b64('card-harbor'),
  };
  const target = (workspace: string, host: string) => ({
    workspace,
    host,
    channelId: 'C0123ABCD45',
    threadTs: '1727880000.000100',
  });

  it('posts with the card token whose team is the row’s host, and only that one', async () => {
    const { calls, fetch } = fakeFetch(slackAnswer);
    const s = slackSender({ keychain: fakeKeychain(CARD_TOKENS), fetch });
    expect(await s.send(target('harbor', 'harborlight'), 'Hi')).toEqual({
      ok: true,
      upstreamId: '1727890001.000200',
    });
    const posts = calls.filter((c) => c.url.endsWith('chat.postMessage'));
    expect(posts.map(bearer)).toEqual(['Bearer card-harbor']);

    // The other team's row goes out with the other token, never this one.
    expect(await s.send(target('river', 'riverbend'), 'Hi')).toMatchObject({ ok: true });
    const after = calls.filter((c) => c.url.endsWith('chat.postMessage'));
    expect(after.map(bearer)).toEqual(['Bearer card-harbor', 'Bearer card-river']);
  });

  it('refuses a row for a team no card token belongs to, and posts nothing', async () => {
    const { calls, fetch } = fakeFetch(slackAnswer);
    const s = slackSender({
      keychain: fakeKeychain({ [card('inbox-slack-token-1')]: b64('card-harbor') }),
      fetch,
    });
    expect(await s.send(target('salt', 'saltmarsh'), 'Hi')).toEqual({
      ok: false,
      error: 'slack: token is for another workspace',
    });
    expect(calls.some((c) => c.url.endsWith('chat.postMessage'))).toBe(false);
  });

  it('asks auth.test once per token, however many rows it answers', async () => {
    const { calls, fetch } = fakeFetch(slackAnswer);
    const s = slackSender({ keychain: fakeKeychain(CARD_TOKENS), fetch });
    await s.send(target('harbor', 'harborlight'), 'a');
    await s.send(target('harbor', 'harborlight'), 'b');
    await s.send(target('river', 'riverbend'), 'c');
    expect(calls.filter((c) => c.url.endsWith('auth.test')).map(bearer)).toEqual([
      'Bearer card-river',
      'Bearer card-harbor',
    ]);
  });

  it('prefers the per-workspace raw entry over the card', async () => {
    const { calls, fetch } = fakeFetch((url, init) =>
      bearer({ url, init }) === 'Bearer raw-harbor' && url.endsWith('auth.test')
        ? { ok: true, url: 'https://harborlight.slack.com/' }
        : slackAnswer(url, init),
    );
    const kc = fakeKeychain({ ...CARD_TOKENS, [`${SLACK_SEND_SERVICE}/harbor`]: 'raw-harbor' });
    const s = slackSender({ keychain: kc, fetch });
    expect(await s.send(target('harbor', 'harborlight'), 'Hi')).toMatchObject({ ok: true });
    expect(calls.map(bearer)).toEqual(['Bearer raw-harbor', 'Bearer raw-harbor']);
    expect(kc.reads.some((r) => r.includes('inbox-slack-token'))).toBe(false);
  });

  it('is maybe-ready when a card token exists, reading no value to say so', () => {
    const kc = fakeKeychain({ [card('inbox-slack-token-2')]: b64('card-harbor') });
    const s = slackSender({ keychain: kc, fetch: fakeFetch(() => ({})).fetch });
    expect(s.ready('anything')).toBe(true);
    expect(kc.reads).toEqual([]);
    expect(
      slackSender({ keychain: fakeKeychain({}), fetch: fakeFetch(() => ({})).fetch }).ready('x'),
    ).toBe(false);
  });
});
