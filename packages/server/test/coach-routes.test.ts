/**
 * The goal coach through the real server and its admission gate.
 *
 * The section, the goals and the answers are Bryan's alone: an Access
 * assertion for the owner email from the front page's own origin, proven
 * the way `inbox-routes.test.ts` proves it. The on-demand check is for a
 * process on this machine, never through the edge, and at most one per
 * ten minutes. No summarizer is passed, so nothing here can reach a model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { CoachStore } from '../src/coach/store.ts';
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
const ZONE = 'America/Los_Angeles';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;
let handle: ServerHandle;
let root: string;
let base: string;
let nudgeId: string;

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
  // A nudge raised a minute ago, written before the server reads the file.
  const seed = new CoachStore(dataDir);
  seed.setGoals(['Publish the Harborlight launch post'], ZONE, Date.now());
  nudgeId = seed.addNudge({
    at: Date.now() - 60_000,
    goalIndex: 0,
    goal: 'Publish the Harborlight launch post',
    drift: 'Most of today went to the Riverbend colour tokens',
    question: 'Is the launch post still first this week?',
  }).id;
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

describe('This week on the front page', () => {
  it('shows the goals and the open nudge to the owner, and nothing to an agent here', async () => {
    const page = await landingAsOwner();
    expect(page).toContain('id="coach"');
    expect(page).toContain('Publish the Harborlight launch post');
    expect(page).toContain('Is the launch post still first this week?');
    const agent = await (await req('/', local())).text();
    expect(agent).not.toContain('id="coach"');
  });
});

describe('POST /coach/goals — the owner alone', () => {
  it('saves this week’s goals from the front page', async () => {
    const goals = ['Ship the Riverbend booking flow', '  Reply to the Saltmarsh partners  ', ''];
    const res = await postJson(
      '/coach/goals',
      { goals, timeZone: ZONE },
      await ownerHeaders(),
      OWNER_HOST,
    );
    expect(res.status).toBe(200);
    const page = await landingAsOwner();
    expect(page).toContain(
      '<li>Ship the Riverbend booking flow</li><li>Reply to the Saltmarsh partners</li></ol>',
    );
  });

  it('refuses an agent on this machine, another origin, and four goals', async () => {
    const goals = ['One'];
    expect((await postJson('/coach/goals', { goals }, {}, local())).status).toBe(403);
    const other = await ownerHeaders({
      origin: 'https://riverbend.example',
      'sec-fetch-site': 'cross-site',
    });
    expect((await postJson('/coach/goals', { goals }, other, OWNER_HOST)).status).toBe(403);
    const four = await postJson(
      '/coach/goals',
      { goals: ['a', 'b', 'c', 'd'] },
      await ownerHeaders(),
      OWNER_HOST,
    );
    expect(four.status).toBe(400);
  });
});

describe('POST /coach/nudges/:id/answer — the owner alone', () => {
  it('refuses an agent, then takes the owner’s answer once and clears the line', async () => {
    const path = `/coach/nudges/${nudgeId}/answer`;
    expect((await postJson(path, { answer: 'back-to-it' }, {}, local())).status).toBe(403);
    const bad = await postJson(path, { answer: 'maybe' }, await ownerHeaders(), OWNER_HOST);
    expect(bad.status).toBe(400);
    const ok = await postJson(path, { answer: 'back-to-it' }, await ownerHeaders(), OWNER_HOST);
    expect(ok.status).toBe(200);
    expect(await landingAsOwner()).not.toContain('data-nudge=');
    const again = await postJson(
      path,
      { answer: 'plans-changed' },
      await ownerHeaders(),
      OWNER_HOST,
    );
    expect(again.status).toBe(404);
  });
});

describe('POST /coach/check — this machine only', () => {
  it('refuses the edge, runs one check locally, then refuses a second inside the floor', async () => {
    const edge = await postJson('/coach/check', {}, await ownerHeaders(), OWNER_HOST);
    expect(edge.status).toBe(403);
    const first = await postJson('/coach/check', {}, {}, local());
    expect(first.status).toBe(200);
    // No activity on this server, and no model either way.
    expect(((await first.json()) as { outcome: string }).outcome).toBe('no-new-activity');
    expect((await postJson('/coach/check', {}, {}, local())).status).toBe(429);
  });
});
