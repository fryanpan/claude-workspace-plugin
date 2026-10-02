/**
 * Bryan's Send through the real server and its admission gate: one test
 * per refusal the design names, the send itself, and the rule that the
 * destination comes from the row, never the request.
 *
 * The owner is proven as `inbox-routes.test.ts` proves them (an Access
 * assertion for the owner email, from the front page's own origin). The
 * transport is a fake that records every call: nothing here reaches Google
 * or Slack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import type { ReplyTarget } from '../src/inbox/reply-target.ts';
import type { ReplyTransport } from '../src/inbox/send-transport.ts';
import { MAX_SENDS_PER_HOUR } from '../src/inbox/sends.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { row } from './inbox-fixtures.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'inbox-reply-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const MEMBER = ['bob', 'riverbend.example'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };
const READER = 'agent-reader';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let configPath: string;
let base: string;
let callerIs: string | null = null;

const sent: Array<{ target: ReplyTarget; text: string }> = [];
const ready = { gmail: true, slack: true };
const transport: ReplyTransport = {
  ready: (t) => ready[t.channel],
  send: async (target, text) => {
    sent.push({ target, text });
    return { ok: true, upstreamId: `up-${sent.length}` };
  },
};

const CONFIG = {
  readerAgentId: READER,
  slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
};

const req = (path: string, host: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
  });
const local = () => `localhost:${handle.port}`;

async function tokenFor(agentId: string): Promise<string> {
  callerIs = agentId;
  const res = await req(`/api/agents/${agentId}/token`, local());
  return ((await res.json()) as { token: string }).token;
}

const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  ...CF_RAY,
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
  ...browser,
});

let seq = 0;
/** A fresh open row the reader posted; its id, read off Bryan's page. */
async function postRow(over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const purpose = `Asks about Riverbend item ${seq}`;
  const res = await req('/inbox/rows', local(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await tokenFor(READER)}`,
    },
    body: JSON.stringify({
      agentId: READER,
      pass: `pass-${seq}`,
      rows: [row({ purpose, receivedAt: Date.now() - 60_000, ...over })],
    }),
  });
  expect(res.status).toBe(200);
  const page = await landing();
  const m = page.match(
    new RegExp(`data-row="(ib-[A-Za-z0-9]{12})"(?:(?!data-row).)*${purpose}<`, 's'),
  );
  expect(m?.[1]).toBeDefined();
  return m?.[1] ?? '';
}

const landing = async () =>
  (await req('/', OWNER_HOST, { headers: await ownerHeaders({}) })).text();

const nonce = () => crypto.randomUUID().replace(/-/g, '');

async function reply(
  id: string,
  body: unknown,
  headers?: Record<string, string>,
  host = OWNER_HOST,
): Promise<Response> {
  return req(`/inbox/rows/${id}/reply`, host, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? (await ownerHeaders())) },
    body: JSON.stringify(body),
  });
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-inbox-reply')
      .sign(privateKey);

  root = mkdtempSync(join(tmpdir(), 'inbox-reply-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  configPath = join(dataDir, 'inbox', 'config.json');
  writeFileSync(configPath, JSON.stringify(CONFIG));
  handle = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    shareLinkHosts: [SHARE_HOST],
    shareLinkAudience: SHARE_AUD,
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    inboxTransport: transport,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

describe('POST /inbox/rows/:id/reply — the send', () => {
  it('sends Bryan’s words as typed on the row’s own Gmail thread, and strikes the line', async () => {
    const id = await postRow({ dedupeKey: 'gmail:18c2f0a1b2c3d4e5' });
    const body = await req(`/inbox/rows/${id}/body`, OWNER_HOST, {
      headers: await ownerHeaders({ 'sec-fetch-site': 'same-origin' }),
    });
    expect(((await body.json()) as { reply: unknown }).reply).toEqual({ kind: 'send' });
    const text = 'Yes, the 14th works.\nSee you there 👋🏽';
    const before = sent.length;
    const res = await reply(id, { text, nonce: nonce() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, state: 'answered', channel: 'gmail' });
    expect(sent.slice(before)).toEqual([
      { target: { channel: 'gmail', threadId: '18c2f0a1b2c3d4e5' }, text },
    ]);
    const page = await landing();
    const line = page.match(
      new RegExp(`<div class="inbox-row inbox-cleared" data-row="${id}".*?</div></div>`, 's'),
    );
    expect(line?.[0]).toContain('You replied on Email at');
    expect(line?.[0]).toContain('clears at the next check');
  });

  it('sends on Slack to the thread in the stored link, on the host the config names', async () => {
    const id = await postRow({
      dedupeKey: 'slack:harbor-thread-1',
      source: 'slack',
      workspace: 'harbor',
      link: 'https://harborlight.slack.com/archives/C0123ABCD45/p1727890000123456?thread_ts=1727880000.000100',
    });
    const before = sent.length;
    expect((await reply(id, { text: 'On it', nonce: nonce() })).status).toBe(200);
    expect(sent.slice(before).map((s) => s.target)).toEqual([
      {
        channel: 'slack',
        workspace: 'harbor',
        host: 'harborlight',
        channelId: 'C0123ABCD45',
        threadTs: '1727880000.000100',
      },
    ]);
  });

  it('takes no destination from the request: a body naming one is refused and nothing is sent', async () => {
    const id = await postRow();
    const before = sent.length;
    for (const extra of [{ threadId: 'ffffffffffffffff' }, { to: MEMBER }, { channel: 'slack' }]) {
      const res = await reply(id, { text: 'Hi', nonce: nonce(), ...extra });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('unknown field');
    }
    expect(sent.length).toBe(before);
  });

  it('refuses a Slack row whose stored host the config no longer names', async () => {
    const id = await postRow({
      dedupeKey: 'slack:harbor-thread-2',
      source: 'slack',
      workspace: 'harbor',
      link: 'https://harborlight.slack.com/archives/C0123ABCD45/p1727890000123456',
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        ...CONFIG,
        slack: [{ workspace: 'harbor', label: 'Harbor', host: 'saltmarsh' }],
      }),
    );
    try {
      const before = sent.length;
      const res = await reply(id, { text: 'Hi', nonce: nonce() });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('destination-changed');
      expect(sent.length).toBe(before);
    } finally {
      writeFileSync(configPath, JSON.stringify(CONFIG));
    }
  });

  it('says Sending isn’t set up when the credential is missing, and sends nothing', async () => {
    const id = await postRow();
    ready.gmail = false;
    try {
      const body = await req(`/inbox/rows/${id}/body`, OWNER_HOST, {
        headers: await ownerHeaders({ 'sec-fetch-site': 'same-origin' }),
      });
      expect(((await body.json()) as { reply: unknown }).reply).toEqual({
        kind: 'unset',
        message: "Sending isn't set up for Email yet.",
      });
      const before = sent.length;
      const res = await reply(id, { text: 'Hi', nonce: nonce() });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: 'send-not-set-up',
        message: "Sending isn't set up for Email yet.",
      });
      expect(sent.length).toBe(before);
    } finally {
      ready.gmail = true;
    }
  });

  it('never sends a text: the page opens Messages instead', async () => {
    const id = await postRow({
      dedupeKey: 'messages:0123456789abcdef',
      source: 'messages',
      workspace: 'texts',
      senderLabel: 'Alice',
      link: 'sms:+15550001111',
    });
    const body = await req(`/inbox/rows/${id}/body`, OWNER_HOST, {
      headers: await ownerHeaders({ 'sec-fetch-site': 'same-origin' }),
    });
    expect(await body.json()).toMatchObject({
      reply: { kind: 'messages' },
      link: 'sms:+15550001111',
    });
    const res = await reply(id, { text: 'Yes', nonce: nonce() });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('sent-in-messages');
  });
});

describe('POST /inbox/rows/:id/reply — every refusal sends nothing', () => {
  let id = '';
  let before = 0;
  beforeAll(async () => {
    id = await postRow();
  });
  const unsent = () => expect(sent.length).toBe(before);

  it('an agent caller on this machine, with no person proof', async () => {
    before = sent.length;
    const res = await reply(id, { text: 'Hi', nonce: nonce() }, {}, local());
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('owner-proof-required');
    unsent();
  });

  it('a trusted-local agent holding its own token, the reader included', async () => {
    before = sent.length;
    const res = await reply(
      id,
      { text: 'Hi', nonce: nonce() },
      { authorization: `Bearer ${await tokenFor(READER)}` },
      local(),
    );
    expect(res.status).toBe(403);
    unsent();
  });

  it('a share visitor', async () => {
    before = sent.length;
    const res = await reply(
      id,
      { text: 'Hi', nonce: nonce() },
      { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER), ...SAME_ORIGIN },
      SHARE_HOST,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    unsent();
  });

  it('the owner’s proof from another Origin', async () => {
    before = sent.length;
    const res = await reply(
      id,
      { text: 'Hi', nonce: nonce() },
      await ownerHeaders({ origin: 'https://riverbend.example', 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
    unsent();
  });

  it('a nonce of the wrong shape', async () => {
    before = sent.length;
    for (const bad of ['short', 'x'.repeat(65), 'has spaces in it ok', 42]) {
      const res = await reply(id, { text: 'Hi', nonce: bad });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('nonce');
    }
    unsent();
  });

  it('text with a direction override', async () => {
    before = sent.length;
    const res = await reply(id, { text: 'Hi ‮evil', nonce: nonce() });
    expect(res.status).toBe(400);
    unsent();
  });

  it('a repeated nonce: the first answer comes back and nothing is sent again', async () => {
    const n = nonce();
    before = sent.length;
    const first = await reply(id, { text: 'Thursday is fine', nonce: n });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(sent.length).toBe(before + 1);
    before = sent.length;
    const again = await reply(id, { text: 'Thursday is fine', nonce: n });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    unsent();
  });

  it('a closed row: answered already, with a new nonce', async () => {
    before = sent.length;
    const res = await reply(id, { text: 'And again', nonce: nonce() });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('not-open');
    unsent();
  });

  it(`over ${MAX_SENDS_PER_HOUR} sends in an hour`, async () => {
    const ids: string[] = [];
    // The tests above sent some already; fill the hour to the limit.
    while (ids.length + sent.length < MAX_SENDS_PER_HOUR + 1) ids.push(await postRow());
    const last = ids.pop() ?? '';
    for (const r of ids) expect((await reply(r, { text: 'Ok', nonce: nonce() })).status).toBe(200);
    expect(sent.length).toBe(MAX_SENDS_PER_HOUR);
    const res = await reply(last, { text: 'One more', nonce: nonce() });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('too-many-sends');
    expect(sent.length).toBe(MAX_SENDS_PER_HOUR);
  });
});
