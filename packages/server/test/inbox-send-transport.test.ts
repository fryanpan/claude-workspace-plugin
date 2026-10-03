/**
 * The Gmail and Slack senders against a fake `fetch` and a fake Keychain:
 * what each sends, to whom, and what it refuses. No call here leaves the
 * process, and no credential is real.
 */
import { describe, expect, it } from 'bun:test';
import { buildReply, gmailSender, singleAddress, subjectHeader } from '../src/inbox/send-gmail.ts';
import {
  GMAIL_SEND_SERVICE,
  SLACK_SEND_SERVICE,
  type SendKeychain,
  keychainFor,
} from '../src/inbox/send-keychain.ts';
import { slackEscape, slackSender } from '../src/inbox/send-slack.ts';
import { systemTransport } from '../src/inbox/send-transport.ts';

// Built at runtime so no address sits in the source.
const ALICE = ['alice', 'riverbend.example'].join('@');
const BOB = ['bob', 'saltmarsh.example'].join('@');

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

const GMAIL_KEYS = {
  [`${GMAIL_SEND_SERVICE}/client-id`]: 'fake-client',
  [`${GMAIL_SEND_SERVICE}/client-secret`]: 'fake-secret',
  [`${GMAIL_SEND_SERVICE}/refresh-token`]: 'fake-refresh',
};

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = answer(url, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  };
  return { calls, fetch };
}

const thread = (messages: unknown[]) => ({ messages });
const msg = (labels: string[], headers: Record<string, string>) => ({
  labelIds: labels,
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
});

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('Gmail', () => {
  const gmailAnswer = (t: unknown) => (url: string) => {
    if (url.includes('oauth2')) return { access_token: 'fake-access', expires_in: 3600 };
    if (url.includes('/threads/')) return t;
    return { id: 'sent-1', threadId: '18c2f0a1b2c3d4e5' };
  };

  it('replies in the thread to the newest inbound sender only, as typed', async () => {
    const t = thread([
      msg(['INBOX'], {
        From: `Alice <${ALICE}>`,
        Subject: 'Saltmarsh dates',
        'Message-ID': '<a1@riverbend.example>',
      }),
      msg(['SENT'], { From: 'me', Subject: 'Re: Saltmarsh dates', 'Message-ID': '<b1@x>' }),
      msg(['INBOX'], {
        From: `"Alice R" <${ALICE}>`,
        Subject: 'Re: Saltmarsh dates',
        'Message-ID': '<a2@riverbend.example>',
        References: '<a1@riverbend.example> <b1@x>',
        'Reply-To': BOB,
      }),
    ]);
    const { calls, fetch } = fakeFetch(gmailAnswer(t));
    const sender = gmailSender({ keychain: fakeKeychain(GMAIL_KEYS), fetch });
    expect(await sender.send('18c2f0a1b2c3d4e5', 'Yes, the 14th.\nThanks')).toEqual({
      ok: true,
      upstreamId: 'sent-1',
    });
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/18c2f0a1b2c3d4e5',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    ]);
    expect(calls[1]?.url).toContain('format=metadata');
    const body = JSON.parse(String(calls[2]?.init.body)) as { raw: string; threadId: string };
    expect(body.threadId).toBe('18c2f0a1b2c3d4e5');
    const mime = decode(body.raw);
    expect(mime).toContain(`To: ${ALICE}\r\n`);
    expect(mime).not.toContain(BOB);
    expect(mime).not.toMatch(/^Cc:/m);
    expect(mime).toContain('Subject: Re: Saltmarsh dates\r\n');
    expect(mime).toContain('In-Reply-To: <a2@riverbend.example>\r\n');
    expect(mime).toContain('References: <a1@riverbend.example> <b1@x> <a2@riverbend.example>\r\n');
    const text = Buffer.from(
      mime.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '',
      'base64',
    ).toString('utf8');
    expect(text).toBe('Yes, the 14th.\r\nThanks');
  });

  it('refuses a thread whose newest sender is not one address, and sends nothing', async () => {
    for (const from of [`${ALICE}, ${BOB}`, `<${ALICE}> <${BOB}>`, 'undisclosed-recipients:;']) {
      const { calls, fetch } = fakeFetch(
        gmailAnswer(thread([msg(['INBOX'], { From: from, Subject: 's' })])),
      );
      const out = await gmailSender({ keychain: fakeKeychain(GMAIL_KEYS), fetch }).send(
        '18c2f0a1b2c3d4e5',
        'Hi',
      );
      expect(out).toEqual({ ok: false, error: 'gmail: no single sender to reply to' });
      expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(false);
    }
  });

  it('names the step and status on a refusal, never the response body', async () => {
    const { fetch } = fakeFetch((url) =>
      url.includes('oauth2')
        ? { access_token: 'fake-access', expires_in: 3600 }
        : new Response('{"error":{"message":"echo of fake-access"}}', { status: 403 }),
    );
    const out = await gmailSender({ keychain: fakeKeychain(GMAIL_KEYS), fetch }).send(
      '18c2f0a1b2c3d4e5',
      'Hi',
    );
    expect(out).toEqual({ ok: false, error: 'gmail: thread read 403' });
  });

  it('is ready only with all three Keychain entries, and reads none to say so', () => {
    const kc = fakeKeychain(GMAIL_KEYS);
    expect(gmailSender({ keychain: kc, fetch: fakeFetch(() => ({})).fetch }).ready()).toBe(true);
    expect(kc.reads).toEqual([]);
    const { [`${GMAIL_SEND_SERVICE}/refresh-token`]: _, ...two } = GMAIL_KEYS;
    expect(
      gmailSender({ keychain: fakeKeychain(two), fetch: fakeFetch(() => ({})).fetch }).ready(),
    ).toBe(false);
  });

  it('keeps a subject on one line, so it cannot add a header', () => {
    expect(subjectHeader('Hi\r\nBcc: someone')).toBe('Re: Hi Bcc: someone');
    expect(subjectHeader('RE: done')).toBe('RE: done');
    expect(subjectHeader('Café')).toBe(`=?UTF-8?B?${Buffer.from('Re: Café').toString('base64')}?=`);
    const mime = decode(
      buildReply({
        to: ALICE,
        subject: 'x\nTo: evil',
        messageId: '<a@b>\r\nBcc: c',
        references: 'junk <ok@x>',
        text: 'y',
      }),
    );
    expect(mime.match(/^To:/gm)).toHaveLength(1);
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).not.toContain('In-Reply-To');
    expect(mime).toContain('References: <ok@x>\r\n');
  });

  it('singleAddress takes one bare or bracketed address and nothing else', () => {
    expect(singleAddress(ALICE)).toBe(ALICE);
    expect(singleAddress(`Alice <${ALICE}>`)).toBe(ALICE);
    expect(singleAddress('Alice')).toBeNull();
    expect(singleAddress(`<${ALICE}>, <${BOB}>`)).toBeNull();
  });
});

describe('Slack', () => {
  const TOKEN = { [`${SLACK_SEND_SERVICE}/harbor`]: 'fake-user-token' };
  const target = {
    workspace: 'harbor',
    host: 'harborlight',
    channelId: 'C0123ABCD45',
    threadTs: '1727880000.000100',
  };

  it('posts in the thread with the workspace’s token, once auth.test names its host', async () => {
    const { calls, fetch } = fakeFetch((url) =>
      url.endsWith('auth.test')
        ? { ok: true, url: 'https://harborlight.slack.com/' }
        : { ok: true, ts: '1727890001.000200' },
    );
    const s = slackSender({ keychain: fakeKeychain(TOKEN), fetch });
    expect(await s.send(target, 'Ship it <@U123> & go')).toEqual({
      ok: true,
      upstreamId: '1727890001.000200',
    });
    expect(await s.send(target, 'again')).toMatchObject({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/auth.test',
      'https://slack.com/api/chat.postMessage',
      'https://slack.com/api/chat.postMessage',
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      channel: 'C0123ABCD45',
      thread_ts: '1727880000.000100',
      text: 'Ship it &lt;@U123&gt; &amp; go',
      unfurl_links: false,
      unfurl_media: false,
    });
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer fake-user-token',
    );
  });

  it('refuses a token that belongs to another workspace', async () => {
    const { calls, fetch } = fakeFetch(() => ({ ok: true, url: 'https://saltmarsh.slack.com/' }));
    const out = await slackSender({ keychain: fakeKeychain(TOKEN), fetch }).send(target, 'Hi');
    expect(out).toEqual({ ok: false, error: 'slack: token is for another workspace' });
    expect(calls.map((c) => c.url)).toEqual(['https://slack.com/api/auth.test']);
  });

  it('reports Slack’s error code, cleaned', async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith('auth.test')
        ? { ok: true, url: 'https://harborlight.slack.com/' }
        : { ok: false, error: 'not_in_channel' },
    );
    expect(await slackSender({ keychain: fakeKeychain(TOKEN), fetch }).send(target, 'Hi')).toEqual({
      ok: false,
      error: 'slack: not_in_channel',
    });
  });

  it('escapes only what Slack would read as markup', () => {
    expect(slackEscape('a < b > c & <!channel>')).toBe('a &lt; b &gt; c &amp; &lt;!channel&gt;');
  });
});

describe('the transport and the Keychain', () => {
  it('routes each channel to its sender and readiness to its own entries', () => {
    const t = systemTransport({
      keychain: fakeKeychain({ [`${SLACK_SEND_SERVICE}/harbor`]: 'fake' }),
      fetch: fakeFetch(() => ({})).fetch,
    });
    expect(t.ready({ channel: 'gmail', threadId: '18c2f0a1b2c3d4e5' })).toBe(false);
    expect(
      t.ready({ channel: 'slack', workspace: 'harbor', host: 'h', channelId: 'C', threadTs: '1' }),
    ).toBe(true);
    expect(
      t.ready({ channel: 'slack', workspace: 'other', host: 'h', channelId: 'C', threadTs: '1' }),
    ).toBe(false);
  });

  it('asks `security` whether an entry exists without -w, so no secret is read', () => {
    const asked: string[][] = [];
    const kc = keychainFor((args) => {
      asked.push(args);
      return { status: 0, stdout: 'attributes only' };
    });
    expect(kc.has(SLACK_SEND_SERVICE, 'harbor')).toBe(true);
    expect(asked).toEqual([['find-generic-password', '-a', 'harbor', '-s', SLACK_SEND_SERVICE]]);
  });
});
