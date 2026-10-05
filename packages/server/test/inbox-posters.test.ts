/**
 * A second poster beside the inbox reader, through the real server.
 *
 * `posterAgentIds` lists the agents that may post rows besides the reader.
 * Each is proved exactly as the reader is — on this machine, with its own
 * token, always — and each may take a row off Bryan's list as handled
 * elsewhere. That dismiss is a history entry by `agent`, and Bryan's Undo
 * or Bring back reopens the row. The owner is proven as in
 * `inbox-routes.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { InboxStore } from '../src/inbox/store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { row } from './inbox-fixtures.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'inbox-posters-kid';
const OWNER_AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };
const READER = 'agent-reader';
const POSTER = 'agent-saltmarsh';
const UNLISTED = 'agent-riverbend';

let jwks: JSONWebKeySet;
let signJwt: (email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let dataDir: string;
let base: string;
let callerIs: string | null = null;

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
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function postAs(agentId: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = token ?? (await tokenFor(agentId));
  if (t) headers.authorization = `Bearer ${t}`;
  return req('/inbox/rows', local(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId, ...body }),
  });
}

const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  'cf-ray': '8a1b2c3d4e5f-SJC',
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_EMAIL),
  ...browser,
});

const landing = async () =>
  (await req('/', OWNER_HOST, { headers: await ownerHeaders({}) })).text();

const tap = async (id: string, action: string) =>
  req(`/inbox/rows/${id}/state`, OWNER_HOST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await ownerHeaders()) },
    body: JSON.stringify({ action }),
  });

/** The stored row for a thread, read back from the file the server wrote. */
const stored = (dedupeKey: string) =>
  new InboxStore(dataDir).list().find((r) => r.dedupeKey === dedupeKey);

const live = (over: Record<string, unknown> = {}) =>
  row({ receivedAt: Date.now() - 25 * 60_000, ...over });

const writeConfig = (config: unknown) =>
  writeFileSync(join(dataDir, 'inbox', 'config.json'), JSON.stringify(config));

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(OWNER_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-inbox-posters')
      .sign(privateKey);

  root = mkdtempSync(join(tmpdir(), 'inbox-posters-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeConfig({ readerAgentId: READER, posterAgentIds: [POSTER] });
  handle = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    shareLinkHosts: ['share.harborlight.test'],
    shareLinkAudience: 'aud-share-app',
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

describe('a second listed poster', () => {
  const pick = live({ purpose: 'Asks about a Harborlight platform role' });
  const key = pick.dedupeKey as string;

  it('posts a row, and does not stamp the reader’s Last checked', async () => {
    const res = await postAs(POSTER, { pass: 'js-1', rows: [pick] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1, created: 1 });
    const page = await landing();
    expect(page).toContain('Asks about a Harborlight platform role');
    expect(page).toContain('Not checked yet');
  });

  it('dismisses a row as handled elsewhere, with no rows in the pass', async () => {
    const res = await postAs(POSTER, {
      pass: 'js-2',
      rows: [],
      dismiss: [
        { dedupeKey: key, reason: 'handled-elsewhere' },
        { dedupeKey: 'gmail:nosuchthread', reason: 'handled-elsewhere' },
        { dedupeKey: key, reason: 'spam' },
      ],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dismissed: unknown }).dismissed).toEqual([
      { index: 0, result: 'dismissed' },
      { index: 1, result: 'not-found' },
      { index: 2, result: 'reason must be handled-elsewhere' },
    ]);
    const r = stored(key);
    expect(r?.state).toBe('dismissed');
    expect(r?.dismissReason).toBe('handled-elsewhere');
    expect(r?.history.at(-1)).toMatchObject({
      from: 'open',
      to: 'dismissed',
      by: 'agent',
      agentId: POSTER,
    });
    // Off the open list, in the fold he can bring it back from.
    expect(await landing()).toContain('Show 1 removed');
  });

  it('a second dismiss of a retired row changes nothing', async () => {
    const res = await postAs(READER, {
      pass: 'rd-1',
      rows: [],
      dismiss: [{ dedupeKey: key, reason: 'handled-elsewhere' }],
    });
    expect(((await res.json()) as { dismissed: unknown }).dismissed).toEqual([
      { index: 0, result: 'not-open' },
    ]);
    expect(stored(key)?.history.filter((h) => h.by === 'agent')).toHaveLength(1);
  });

  it('Bryan’s Undo reopens the row a poster dismissed', async () => {
    const id = stored(key)?.id ?? '';
    const res = await tap(id, 'undo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, state: 'open' });
    expect(stored(key)?.history.at(-1)).toMatchObject({ by: 'owner', why: 'undo', to: 'open' });
  });

  it('refuses an unlisted agent, holding its own valid token', async () => {
    const res = await postAs(UNLISTED, {
      pass: 'x',
      rows: [],
      dismiss: [{ dedupeKey: key, reason: 'handled-elsewhere' }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not-the-inbox-reader');
    expect(stored(key)?.state).toBe('open');
  });

  it('refuses a listed poster with no token, or another agent’s token', async () => {
    const none = await postAs(POSTER, { pass: 'x', rows: [live()] }, '');
    expect(none.status).toBe(401);
    const theirs = await tokenFor(UNLISTED);
    const wrong = await postAs(
      POSTER,
      { pass: 'x', rows: [], dismiss: [{ dedupeKey: key, reason: 'handled-elsewhere' }] },
      theirs,
    );
    expect(wrong.status).toBe(403);
    expect(stored(key)?.state).toBe('open');
  });

  it('refuses a dismiss of a thread the same pass posts', async () => {
    const again = live({ dedupeKey: key });
    const res = await postAs(POSTER, {
      pass: 'js-3',
      rows: [again],
      dismiss: [{ dedupeKey: key, reason: 'handled-elsewhere' }],
    });
    expect(((await res.json()) as { dismissed: unknown }).dismissed).toEqual([
      { index: 0, result: 'posted in this pass' },
    ]);
    expect(stored(key)?.state).toBe('open');
  });
});

describe('the old config shape', () => {
  it('a readerAgentId-only file lets the reader post and nobody else', async () => {
    writeConfig({ readerAgentId: READER });
    const reader = await postAs(READER, { pass: 'rd-2', rows: [live()] });
    expect(reader.status).toBe(200);
    expect(await landing()).not.toContain('Not checked yet');
    const was = await postAs(POSTER, { pass: 'js-4', rows: [live()] });
    expect(was.status).toBe(403);
    writeConfig({ readerAgentId: READER, posterAgentIds: [POSTER] });
  });
});
