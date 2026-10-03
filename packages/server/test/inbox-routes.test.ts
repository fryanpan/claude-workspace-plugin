/**
 * Incoming Messages through the real server and its admission gate.
 *
 * The post is the reader's alone: its own token, on this machine, not
 * through the edge, not from a page. The front-page section, the message
 * text and the taps are Bryan's alone: an Access assertion for the owner
 * email from the front page's own origin. The owner is proven the way
 * `task-grants-door.test.ts` proves them; the reader's process is the
 * injected `identifyAgentCaller` that `agent-stream-auth.test.ts` uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { NOW, row } from './inbox-fixtures.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'inbox-routes-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
// Built at runtime so no address sits in the source.
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const MEMBER = ['bob', 'riverbend.example'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };
const READER = 'agent-reader';
const OTHER = 'agent-riverbend';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let base: string;
let callerIs: string | null = null;

const req = (path: string, host: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
  });
const local = () => `localhost:${handle.port}`;

/** The token this server mints for `agentId`'s own process. */
async function tokenFor(agentId: string): Promise<string> {
  callerIs = agentId;
  const res = await req(`/api/agents/${agentId}/token`, local());
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const postRows = (body: unknown, headers: Record<string, string> = {}, host = local()) =>
  req('/inbox/rows', host, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  ...CF_RAY,
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
  ...browser,
});

const landingAsOwner = async () =>
  (await req('/', OWNER_HOST, { headers: await ownerHeaders({}) })).text();

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
      .setSubject('cf-access-inbox')
      .sign(privateKey);

  root = mkdtempSync(join(tmpdir(), 'inbox-routes-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(
    join(dataDir, 'inbox', 'config.json'),
    JSON.stringify({
      readerAgentId: READER,
      slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
    }),
  );
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
    // Never the real Keychain: the body read asks whether Send is set up.
    inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

/** Rows dated against the real clock: the server checks receivedAt on it. */
const live = (over: Record<string, unknown> = {}) =>
  row({ receivedAt: Date.now() - 25 * 60_000, ...over });

describe('POST /inbox/rows — the reader alone', () => {
  it('stores the reader’s pass and lists each refused row by index, without echoing it', async () => {
    const AT_DOMAIN = ['bob', 'riverbend.example'].join('@');
    const good = live({ purpose: 'Wants a yes on the Saltmarsh dates' });
    const res = await postRows(
      {
        agentId: READER,
        pass: 'pass-1',
        rows: [
          good,
          live({ purpose: '<img src=x onerror=alert(1)>' }),
          live({ purpose: `Reply to ${AT_DOMAIN}` }),
          live({ link: 'javascript:alert(1)' }),
          live({ purpose: 'x'.repeat(500) }),
        ],
      },
      { authorization: `Bearer ${await tokenFor(READER)}` },
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toEqual({
      ok: true,
      accepted: 1,
      created: 1,
      updated: 0,
      rejected: [
        { index: 1, reason: 'purpose: markup' },
        { index: 2, reason: 'purpose: address' },
        { index: 3, reason: 'link is not an allowed form' },
        { index: 4, reason: 'purpose: over 140 characters' },
      ],
    });
    const page = await landingAsOwner();
    expect(page).toContain('Wants a yes on the Saltmarsh dates');
    expect(page).not.toContain('onerror');
    expect(page).not.toContain(AT_DOMAIN);
  });

  it('refuses another agent, even holding its own valid token', async () => {
    const res = await postRows(
      { agentId: OTHER, pass: 'p', rows: [live()] },
      { authorization: `Bearer ${await tokenFor(OTHER)}` },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not-the-inbox-reader');
  });

  it('refuses another agent naming the reader, with its own token', async () => {
    const res = await postRows(
      { agentId: READER, pass: 'p', rows: [live()] },
      { authorization: `Bearer ${await tokenFor(OTHER)}` },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('agent-token-mismatch');
  });

  it('refuses a caller with no token, or a forged one', async () => {
    const none = await postRows({ agentId: READER, pass: 'p', rows: [live()] });
    expect(none.status).toBe(401);
    const forged = await postRows(
      { agentId: READER, pass: 'p', rows: [live()] },
      { authorization: `Bearer at1.${READER}.notavalidmacatall` },
    );
    expect(forged.status).toBe(403);
  });

  it('refuses a page in a browser on this machine, holding the reader’s token', async () => {
    const token = await tokenFor(READER);
    // An unsigned page is stopped at the write gate; a signed-in one would
    // reach `authorizeAgentCaller`, which refuses any browser outright.
    const browsers: Record<string, string>[] = [
      { 'sec-fetch-dest': 'empty' },
      { origin: `http://${local()}`, 'sec-fetch-site': 'same-origin' },
    ];
    for (const browser of browsers) {
      const page = await postRows(
        { agentId: READER, pass: 'p-browser', rows: [live({ purpose: 'From a page' })] },
        { authorization: `Bearer ${token}`, ...browser },
      );
      expect(page.status).toBe(401);
    }
    expect(await landingAsOwner()).not.toContain('From a page');
  });

  it('refuses the owner through the edge, and a share visitor', async () => {
    const owner = await postRows(
      { agentId: READER, pass: 'p', rows: [live()] },
      await ownerHeaders(),
      OWNER_HOST,
    );
    expect(owner.status).toBe(403);
    const visitor = await postRows(
      { agentId: READER, pass: 'p', rows: [live()] },
      { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER) },
      SHARE_HOST,
    );
    expect(visitor.status).toBeGreaterThanOrEqual(400);
    expect(visitor.status).toBeLessThan(500);
  });

  it('refuses an unknown top-level field and an oversized pass', async () => {
    const token = await tokenFor(READER);
    const extra = await postRows(
      { agentId: READER, pass: 'p', rows: [live()], html: '<b>' },
      { authorization: `Bearer ${token}` },
    );
    expect(extra.status).toBe(400);
    const tooMany = await postRows(
      { agentId: READER, pass: 'p', rows: Array.from({ length: 41 }, () => live()) },
      { authorization: `Bearer ${token}` },
    );
    expect(tooMany.status).toBe(400);
  });
});

describe('the section and the taps — Bryan alone', () => {
  let id = '';

  beforeAll(async () => {
    const res = await postRows(
      {
        agentId: READER,
        pass: 'pass-2',
        rows: [live({ purpose: 'Asks whether Riverbend can move to Thursday', body: 'Thursday?' })],
      },
      { authorization: `Bearer ${await tokenFor(READER)}` },
    );
    expect(res.status).toBe(200);
    const page = await landingAsOwner();
    const m = page.match(
      /data-row="(ib-[A-Za-z0-9]{12})"[^>]*>(?:(?!data-row).)*Asks whether Riverbend/s,
    );
    id = m?.[1] ?? '';
    expect(id).not.toBe('');
  });

  it('the front page shows the section to the owner only', async () => {
    expect(await landingAsOwner()).toContain('id="inbox"');
    const agent = await (await req('/', local())).text();
    expect(agent).not.toContain('id="inbox"');
    expect(agent).not.toContain('Riverbend can move');
  });

  it('the owner reads the text from the front page; an agent on this machine cannot', async () => {
    const own = await req(`/inbox/rows/${id}/body`, OWNER_HOST, {
      headers: await ownerHeaders({ 'sec-fetch-site': 'same-origin' }),
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ id, body: 'Thursday?' });
    expect(own.headers.get('cache-control')).toBe('no-store');
    const agent = await req(`/inbox/rows/${id}/body`, local());
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as { error: string }).error).toBe('owner-proof-required');
    // The reader too: its token proves an agent, never the owner.
    const reader = await req(`/inbox/rows/${id}/body`, local(), {
      headers: { authorization: `Bearer ${await tokenFor(READER)}` },
    });
    expect(reader.status).toBe(403);
  });

  it('a tap from another origin is refused even with the owner’s proof', async () => {
    const cross = await req(`/inbox/rows/${id}/state`, OWNER_HOST, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await ownerHeaders({
          origin: 'https://riverbend.example',
          'sec-fetch-site': 'cross-site',
        })),
      },
      body: JSON.stringify({ action: 'answer' }),
    });
    expect(cross.status).toBe(403);
    // The page's own Origin but no Sec-Fetch-Site: past the write gate, and
    // refused by the route's own check.
    const unfetched = await req(`/inbox/rows/${id}/state`, OWNER_HOST, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await ownerHeaders({ origin: `https://${OWNER_HOST}` })),
      },
      body: JSON.stringify({ action: 'answer' }),
    });
    expect(unfetched.status).toBe(403);
    expect(((await unfetched.json()) as { error: string }).error).toBe('same-origin-only');
  });

  it('the owner snoozes a row and brings it back', async () => {
    const tap = async (body: unknown) =>
      req(`/inbox/rows/${id}/state`, OWNER_HOST, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await ownerHeaders()) },
        body: JSON.stringify(body),
      });
    const until = Date.now() + 3_600_000;
    const snoozed = await tap({ action: 'snooze', until });
    expect(snoozed.status).toBe(200);
    expect(await snoozed.json()).toEqual({ id, state: 'snoozed', snoozedUntil: until });
    expect(await landingAsOwner()).toContain('Show 1 snoozed');
    expect((await tap({ action: 'reopen' })).status).toBe(200);
    expect((await tap({ action: 'teleport' })).status).toBe(400);
    expect((await tap({ action: 'dismiss', reason: 'because' })).status).toBe(400);
  });

  it('an agent cannot tap', async () => {
    const res = await req(`/inbox/rows/${id}/state`, local(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'answer' }),
    });
    expect(res.status).toBe(403);
  });

  it('a malformed id is a 404 before any gate reads a row', async () => {
    const res = await req('/inbox/rows/../../etc/state', local());
    expect([403, 404]).toContain(res.status);
    const bad = await req('/inbox/rows/ib-short/body', local());
    expect(bad.status).toBe(404);
  });
});

describe('Remove — Bryan alone, and reversible', () => {
  let id = '';
  const removeBody = JSON.stringify({ action: 'remove' });
  const tap = async (body: string, headers: Record<string, string>, host = OWNER_HOST) =>
    req(`/inbox/rows/${id}/state`, host, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  beforeAll(async () => {
    const res = await postRows(
      {
        agentId: READER,
        pass: 'pass-remove',
        rows: [live({ purpose: 'Sends the Harborlight survey for a look', body: 'Survey' })],
      },
      { authorization: `Bearer ${await tokenFor(READER)}` },
    );
    expect(res.status).toBe(200);
    const m = (await landingAsOwner()).match(
      /data-row="(ib-[A-Za-z0-9]{12})"[^>]*>(?:(?!data-row).)*Harborlight survey/s,
    );
    id = m?.[1] ?? '';
    expect(id).not.toBe('');
  });

  it('refuses an agent on this machine, the reader included', async () => {
    expect((await tap(removeBody, {}, local())).status).toBe(403);
    const reader = await tap(
      removeBody,
      { authorization: `Bearer ${await tokenFor(READER)}` },
      local(),
    );
    expect(reader.status).toBe(403);
  });

  it('refuses a share visitor', async () => {
    const res = await tap(
      removeBody,
      {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER),
        origin: `https://${SHARE_HOST}`,
        'sec-fetch-site': 'same-origin',
      },
      SHARE_HOST,
    );
    expect(res.status).toBe(403);
  });

  it('refuses the owner from another origin', async () => {
    const res = await tap(
      removeBody,
      await ownerHeaders({ origin: 'https://riverbend.example', 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a state it does not know', async () => {
    const res = await tap(JSON.stringify({ action: 'delete' }), await ownerHeaders());
    expect(res.status).toBe(400);
  });

  it('moves the line into the Removed fold, and undo puts it back', async () => {
    const res = await tap(removeBody, await ownerHeaders());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, state: 'dismissed' });
    const page = await landingAsOwner();
    expect(page).toContain('Show 1 removed');
    expect(page).toMatch(/data-fold-body="removed"[^>]*>(?:(?!<\/section>).)*Harborlight survey/s);
    const undo = await tap(JSON.stringify({ action: 'undo' }), await ownerHeaders());
    expect(await undo.json()).toEqual({ id, state: 'open' });
    expect(await landingAsOwner()).not.toContain('Show 1 removed');
  });
});

void NOW;
