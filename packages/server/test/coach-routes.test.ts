/**
 * The coach through the real server and its admission gate.
 *
 * Every page route is Bryan's alone: an Access assertion for the owner email
 * from this server's own pages, proven the way `inbox-routes.test.ts` proves
 * it. Setup makes a real bound doc on a real board; the where-I-am signal is
 * checked against that board; the stream is an event stream for him and a
 * refusal for anyone else. The on-demand check is for a process on this
 * machine. No summarizer is passed, so nothing here can reach a model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'coach-routes-kid';
const OWNER_AUD = 'aud-owner-app';
const SHARE_AUD = 'aud-share-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let base: string;
let goalsUrl: string;

const req = (path: string, host: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
  });
const local = () => `localhost:${handle.port}`;

const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  ...CF_RAY,
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
  ...browser,
});

const landingAsOwner = async () =>
  (await req('/', OWNER_HOST, { headers: await ownerHeaders({}) })).text();

const postJson = (path: string, body: unknown, headers: Record<string, string>, host: string) =>
  req(path, host, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

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
      .setSubject('cf-access-coach')
      .sign(privateKey);

  root = mkdtempSync(join(tmpdir(), 'coach-routes-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
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
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

const ids = () => {
  const m = goalsUrl.match(/^\/workspaces\/([^/]+)\/docs\/([^/]+)$/);
  return { workspaceId: decodeURIComponent(m?.[1] ?? ''), docId: decodeURIComponent(m?.[2] ?? '') };
};

describe('Your coach on the front page, and setup', () => {
  it('offers setup to the owner and nothing to an agent here', async () => {
    expect(await landingAsOwner()).toContain('data-act="setup"');
    expect(await (await req('/', local())).text()).not.toContain('id="coach"');
  });

  it('makes the learning-goals doc once, bound and on its own board', async () => {
    const first = await postJson('/coach/setup', {}, await ownerHeaders(), OWNER_HOST);
    expect(first.status).toBe(200);
    goalsUrl = ((await first.json()) as { url: string }).url;
    const again = await postJson('/coach/setup', {}, await ownerHeaders(), OWNER_HOST);
    expect(((await again.json()) as { url: string }).url).toBe(goalsUrl);
    const { workspaceId, docId } = ids();
    const list = (await (await req('/workspaces', local())).json()) as {
      boardWorkspaces: { id: string; name: string; docCount: number }[];
    };
    expect(list.boardWorkspaces.find((w) => w.id === workspaceId)).toMatchObject({
      name: 'Coach',
      docCount: 1,
    });
    const doc = (await (
      await req(`/workspaces/${workspaceId}/docs/${docId}?format=json`, local())
    ).json()) as {
      meta: { title: string; sourceUrl: string };
    };
    expect(doc.meta.title).toBe('Learning goals');
    expect(doc.meta.sourceUrl.endsWith(join('data', 'coach', 'learning-goals.md'))).toBe(true);
    const page = await landingAsOwner();
    expect(page).toContain(`href="${goalsUrl}">Learning goals</a>`);
    expect(page).toContain('No goals yet.');
  });

  it('refuses an agent here, another origin, and a share visitor', async () => {
    expect((await postJson('/coach/setup', {}, {}, local())).status).toBe(403);
    const other = await ownerHeaders({
      origin: 'https://riverbend.example',
      'sec-fetch-site': 'cross-site',
    });
    expect((await postJson('/coach/setup', {}, other, OWNER_HOST)).status).toBe(403);
    expect((await postJson('/coach/prefs', { spacing: 'more' }, {}, SHARE_HOST)).status).toBe(403);
  });
});

describe('the owner’s settings and answers', () => {
  it('takes a how-often setting and refuses one that is not offered', async () => {
    const h = await ownerHeaders();
    expect((await postJson('/coach/prefs', { spacing: 'often' }, h, OWNER_HOST)).status).toBe(400);
    expect((await postJson('/coach/prefs', { spacing: 'more' }, h, OWNER_HOST)).status).toBe(200);
    expect(await landingAsOwner()).toContain('data-spacing="more" aria-pressed="true"');
  });

  it('adds a goal, takes “no update needed”, and has no moment to answer', async () => {
    const h = await ownerHeaders();
    expect((await postJson('/coach/goals/add', {}, h, OWNER_HOST)).status).toBe(200);
    expect((await postJson('/coach/review', { answer: 'later' }, h, OWNER_HOST)).status).toBe(400);
    expect((await postJson('/coach/review', { answer: 'no-update' }, h, OWNER_HOST)).status).toBe(
      200,
    );
    const answer = await postJson(
      '/coach/moments/cm-aaaaaaaaaaaa/answer',
      { answer: 'thanks' },
      h,
      OWNER_HOST,
    );
    expect(answer.status).toBe(404);
    const bad = await postJson(
      '/coach/moments/cm-aaaaaaaaaaaa/answer',
      { answer: 'yes' },
      h,
      OWNER_HOST,
    );
    expect(bad.status).toBe(400);
  });
});

describe('POST /coach/here', () => {
  it('takes where he is on a board and doc that exist, refuses the rest, and tells anyone else to stop', async () => {
    const { workspaceId, docId } = ids();
    const h = await ownerHeaders();
    const ok = await postJson(
      '/coach/here',
      { workspaceId, docId, visible: true, scrollPct: 40, heading: 'How' },
      h,
      OWNER_HOST,
    );
    expect(ok.status).toBe(200);
    const board = await postJson('/coach/here', { workspaceId, visible: false }, h, OWNER_HOST);
    expect(board.status).toBe(200);
    const cases: unknown[] = [
      { workspaceId: 'w-nowhere', visible: true },
      { workspaceId, docId: 'd-not-on-it', visible: true },
      { workspaceId, docId, visible: 'yes' },
      { workspaceId, docId, visible: true, scrollPct: 140 },
      { workspaceId: '../etc', visible: true },
    ];
    for (const body of cases)
      expect((await postJson('/coach/here', body, h, OWNER_HOST)).status).toBe(400);
    // Not the owner: an empty answer that tells the page to stop, not a refusal.
    expect(
      (await postJson('/coach/here', { workspaceId, visible: true }, {}, local())).status,
    ).toBe(204);
    // The owner's cookie from another site is still refused.
    const cross = await postJson(
      '/coach/here',
      { workspaceId, visible: true },
      { ...h, 'sec-fetch-site': 'cross-site' },
      OWNER_HOST,
    );
    expect(cross.status).toBe(403);
  });
});

describe('GET /coach/stream', () => {
  it('is an event stream for the owner’s own page, and refused to anyone else', async () => {
    const own = await req('/coach/stream', OWNER_HOST, {
      headers: { ...(await ownerHeaders({ 'sec-fetch-site': 'same-origin' })) },
    });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('text/event-stream');
    await own.body?.cancel();
    const cross = await req('/coach/stream', OWNER_HOST, {
      headers: { ...(await ownerHeaders({ 'sec-fetch-site': 'cross-site' })) },
    });
    expect(cross.status).toBe(403);
    expect((await req('/coach/stream', local())).status).toBe(403);
  });
});

describe('POST /coach/check — this machine only', () => {
  it('refuses the edge, and here passes the gates: no goal says when yet', async () => {
    expect((await postJson('/coach/check', {}, await ownerHeaders(), OWNER_HOST)).status).toBe(403);
    const res = await postJson('/coach/check', {}, {}, local());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'no-goals' });
  });
});
