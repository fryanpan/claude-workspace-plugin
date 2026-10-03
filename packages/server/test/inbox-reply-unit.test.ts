/**
 * Bryan's Send below the route: where a row's reply goes, the words it
 * accepts, the nonce and hourly ledger, and the struck-through line it
 * leaves until the next pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInboxConfig } from '../src/inbox/config.ts';
import { replyTargetFor } from '../src/inbox/reply-target.ts';
import { InboxReplies } from '../src/inbox/reply.ts';
import { renderInboxSection } from '../src/inbox/section.ts';
import type { ReplyTransport, SendOutcome } from '../src/inbox/send-transport.ts';
import { InboxSends, MAX_SENDS_PER_HOUR } from '../src/inbox/sends.ts';
import { InboxStore } from '../src/inbox/store.ts';
import { checkReplyText } from '../src/inbox/text-checks.ts';
import type { InboxRow, InboxRowInput } from '../src/inbox/types.ts';
import { CONFIG, NOW } from './inbox-fixtures.ts';

const input = (over: Partial<InboxRowInput> = {}): InboxRowInput => ({
  dedupeKey: 'gmail:18c2f0a1b2c3d4e5',
  source: 'gmail',
  workspace: 'email',
  senderLabel: 'Alice',
  senderKey: 'a1b2c3d4e5f60718',
  senderKnown: true,
  purpose: 'Wants a yes on the Saltmarsh dates',
  askKind: 'decision',
  replyBy: 'today',
  goal: null,
  link: null,
  receivedAt: NOW - 60_000,
  messageCount: 1,
  lastFromOwner: false,
  ...over,
});

const stored = (over: Partial<InboxRowInput> = {}): InboxRow => ({
  ...input(over),
  id: 'ib-aaaaaaaaaaaa',
  state: 'open',
  history: [],
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  pass: 'p',
});

describe('replyTargetFor — the destination is the row’s', () => {
  it('Email: the thread id in the key, else the one in the link', () => {
    expect(replyTargetFor(stored(), CONFIG)).toEqual({
      ok: true,
      target: { channel: 'gmail', threadId: '18c2f0a1b2c3d4e5' },
    });
    const viaLink = stored({
      dedupeKey: 'gmail:thread-x',
      link: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c30009',
    });
    expect(replyTargetFor(viaLink, CONFIG)).toMatchObject({
      target: { threadId: '18c2f0a1b2c30009' },
    });
    expect(replyTargetFor(stored({ dedupeKey: 'gmail:thread-x' }), CONFIG)).toEqual({
      ok: false,
      error: 'no-destination',
    });
  });

  it('Slack: the message itself is the thread when the link names no parent', () => {
    const slack = stored({
      source: 'slack',
      workspace: 'harbor',
      dedupeKey: 'slack:x',
      link: 'https://harborlight.slack.com/archives/C0123ABCD45/p1727890000123456',
    });
    expect(replyTargetFor(slack, CONFIG)).toMatchObject({
      target: { channelId: 'C0123ABCD45', threadTs: '1727890000.123456', host: 'harborlight' },
    });
  });

  it('refuses a workspace the config dropped, or one now on another source', () => {
    const gone = parseInboxConfig({ readerAgentId: 'r' }).config;
    const slack = stored({
      source: 'slack',
      workspace: 'harbor',
      link: 'https://harborlight.slack.com/archives/C0123ABCD45/p1727890000123456',
    });
    expect(replyTargetFor(slack, gone)).toEqual({ ok: false, error: 'destination-changed' });
    expect(replyTargetFor(stored({ source: 'messages' }), CONFIG)).toEqual({
      ok: false,
      error: 'destination-changed',
    });
  });
});

describe('checkReplyText', () => {
  it('keeps lines, tabs and emoji joiners, and refuses controls and overrides', () => {
    expect(checkReplyText('Yes\n\tthe 14th 👩🏽‍💻')).toEqual({
      ok: true,
      value: 'Yes\n\tthe 14th 👩🏽‍💻',
    });
    expect(checkReplyText('a\r\nb')).toEqual({ ok: true, value: 'a\nb' });
    expect(checkReplyText('  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkReplyText('a\u0007b')).toMatchObject({ ok: false, reason: 'control character' });
    expect(checkReplyText('a⁦b')).toMatchObject({ ok: false, reason: 'direction override' });
    expect(checkReplyText('x'.repeat(4001))).toMatchObject({ ok: false });
    expect(checkReplyText('😀'.repeat(4000))).toMatchObject({ ok: true });
  });
});

describe('InboxReplies', () => {
  let dir: string;
  let store: InboxStore;
  let sends: InboxSends;
  let calls: string[];
  let outcome: () => Promise<SendOutcome>;
  let replies: InboxReplies;
  let id: string;
  const transport: ReplyTransport = {
    ready: () => true,
    send: async (_t, text) => {
      calls.push(text);
      return outcome();
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbox-reply-unit-'));
    store = new InboxStore(dir, () => NOW);
    sends = new InboxSends(dir, () => NOW);
    calls = [];
    outcome = async () => ({ ok: true, upstreamId: 'msg-1' });
    replies = new InboxReplies({
      store,
      sends,
      config: () => CONFIG,
      transport,
      now: () => NOW,
      log: () => {},
    });
    const posted = store.post([input()], 'p1');
    id = posted.ok ? (posted.ids[0] ?? '') : '';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('answers the row by owner-send, with the channel and the source’s id', async () => {
    const res = await replies.reply(id, { text: 'Yes', nonce: 'n'.repeat(16) });
    expect(res).toEqual({
      status: 200,
      body: { id, state: 'answered', channel: 'gmail', sentAt: NOW },
    });
    expect(store.get(id)?.history.at(-1)).toEqual({
      at: NOW,
      from: 'open',
      to: 'answered',
      by: 'owner-send',
      channel: 'gmail',
      upstreamId: 'msg-1',
    });
    expect(statSync(join(dir, 'inbox', 'sends.json')).mode & 0o777).toBe(0o600);
  });

  it('a nonce sent twice at once reaches the transport once, and both get one answer', async () => {
    let release: () => void = () => {};
    outcome = () =>
      new Promise((r) => {
        release = () => r({ ok: true, upstreamId: 'msg-2' });
      });
    const n = 'k'.repeat(20);
    const a = replies.reply(id, { text: 'Yes', nonce: n });
    const b = replies.reply(id, { text: 'Yes', nonce: n });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(calls).toEqual(['Yes']);
  });

  it('a second nonce while the first send is in flight is refused', async () => {
    let release: () => void = () => {};
    outcome = () =>
      new Promise((r) => {
        release = () => r({ ok: true, upstreamId: 'msg-3' });
      });
    const a = replies.reply(id, { text: 'One', nonce: 'a'.repeat(16) });
    const b = await replies.reply(id, { text: 'Two', nonce: 'b'.repeat(16) });
    release();
    await a;
    expect(b).toEqual({ status: 409, body: { error: 'send-in-flight' } });
    expect(calls).toEqual(['One']);
  });

  it('a transport that throws is a 502, recorded, and the row stays open', async () => {
    outcome = async () => {
      throw new Error('socket hang up');
    };
    const n = 'c'.repeat(16);
    const res = await replies.reply(id, { text: 'Yes', nonce: n });
    expect(res.status).toBe(502);
    expect(String(res.body.message)).toContain('gmail: network');
    expect(store.get(id)?.state).toBe('open');
    expect(sends.answered(id, n, NOW)).toEqual(res);
    expect(sends.inLastHour(NOW)).toBe(1);
  });

  it('counts the hour from the ledger, so a restart keeps the limit', async () => {
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) {
      sends.record({
        rowId: 'ib-other',
        nonce: `n${i}`,
        at: NOW - 1000,
        channel: 'gmail',
        text: 'x',
        answer: { status: 200, body: {} },
      });
    }
    const reread = new InboxReplies({
      store,
      sends: new InboxSends(dir, () => NOW),
      config: () => CONFIG,
      transport,
      now: () => NOW,
      log: () => {},
    });
    expect((await reread.reply(id, { text: 'Yes', nonce: 'd'.repeat(16) })).status).toBe(429);
    expect(calls).toEqual([]);
  });
});

describe('the sent line', () => {
  const section = (row: InboxRow, lastPassAt: number) =>
    renderInboxSection({
      rows: [row],
      config: CONFIG,
      projectRank: () => undefined,
      goalIndex: () => undefined,
      goalTitle: () => undefined,
      lastPassAt,
      now: NOW,
    });
  const answered = stored({});
  answered.state = 'answered';
  answered.history = [
    { at: NOW - 1000, from: 'open', to: 'answered', by: 'owner-send', channel: 'gmail' },
  ];

  it('stays, struck through, until the next pass', () => {
    const html = section(answered, NOW - 5000);
    expect(html).toContain('inbox-row inbox-cleared');
    expect(html).toContain('clears at the next check');
    expect(html).toContain('0 open');
  });

  it('is gone once a pass has run since', () => {
    expect(section(answered, NOW)).not.toContain('inbox-cleared');
  });

  it('is not drawn for a row the reader answered', () => {
    const byReader = {
      ...answered,
      history: [{ ...answered.history[0], by: 'reader' } as InboxRow['history'][number]],
    };
    expect(section(byReader, NOW - 5000)).not.toContain('inbox-cleared');
  });
});
