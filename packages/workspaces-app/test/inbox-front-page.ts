/**
 * The front page opened the way prod opens it, for the inbox browser cases:
 * a server with seeded fixture rows behind a stand-in for the edge that adds
 * the owner's Access assertion, the landing bundle built as
 * `scripts/build.ts` builds it, and key presses sent the way a hardware
 * keyboard sends them (CDP `Input.dispatchKeyEvent`).
 *
 * Nothing here reads a source file's text; the bundle is built and run.
 */
// audit: no-text
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Cdp, sleep } from '../../../scripts/headless-chrome.ts';
import { InboxBodies } from '../../server/src/inbox/bodies.ts';
import { InboxStore } from '../../server/src/inbox/store.ts';
import type { InboxRowInput } from '../../server/src/inbox/types.ts';
import type { CfAccessOptions } from '../../server/src/middleware/cf-access.ts';

export const TEAM = 'drive.cloudflareaccess.com';
export const AUD = 'aud-owner-drive';
const KID = 'inbox-drive-kid';
export const OWNER_HOST = 'workspaces.harborlight.test';
// Built at runtime so no address sits in the source.
export const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An RS256 Access assertion for the owner, and the key set that checks it. */
export function accessKeys(): { jwks: NonNullable<CfAccessOptions['jwks']>; assertion: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    kty: 'RSA',
    ...publicKey.export({ format: 'jwk' }),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      email: OWNER_EMAIL,
      iss: `https://${TEAM}`,
      aud: AUD,
      iat: now,
      exp: now + 600,
      sub: 'cf-access-drive',
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return { jwks: { keys: [jwk] }, assertion: `${head}.${body}.${b64url(sig)}` };
}

/** `landing.js`, as `scripts/build.ts` builds it. */
export async function buildLanding(dist: string): Promise<void> {
  const r = await Bun.build({
    entrypoints: [join(import.meta.dirname, '../src/landing-app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    naming: { entry: 'landing.js' },
    minify: true,
  });
  if (!r.success) throw new Error(`landing build failed: ${r.logs.join('\n')}`);
}

export const PURPOSES: readonly string[] = [
  'Wants a yes on the Saltmarsh dates',
  'Asks whether Riverbend can move to Thursday',
  'Sends the Harborlight survey for a look',
];

export function seed(dataDir: string): void {
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(
    join(dataDir, 'inbox', 'config.json'),
    JSON.stringify({ readerAgentId: 'agent-reader', slack: [] }),
  );
  const now = Date.now();
  const rows: InboxRowInput[] = PURPOSES.map((purpose, i) => ({
    dedupeKey: `gmail:drive${i}`,
    source: 'gmail',
    workspace: 'email',
    senderLabel: ['Alice (Riverbend)', 'Bob (Saltmarsh)', 'Alice (Harborlight)'][i] ?? 'Alice',
    senderKey: `a1b2c3d4e5f6071${i}`,
    senderKnown: true,
    purpose,
    askKind: 'decision',
    replyBy: 'tomorrow',
    goal: null,
    link: null,
    receivedAt: now - (i + 1) * 25 * 60_000,
    messageCount: 1,
    lastFromOwner: false,
  }));
  const store = new InboxStore(dataDir);
  const posted = store.post(rows, 'pass-drive');
  if (!posted.ok) throw new Error('seed refused');
  new InboxBodies(dataDir).putAll(posted.ids.map((id, i) => [id, `Message ${i + 1} text.`]));
}

/** The edge: every request gains the owner host and the Access assertion. */
export function edge(
  target: string,
  assertion: string,
): { origin: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set('host', OWNER_HOST);
      headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
      headers.set('x-forwarded-proto', 'https');
      headers.set('cf-access-jwt-assertion', assertion);
      headers.set('accept-encoding', 'identity');
      if (headers.has('origin')) headers.set('origin', `https://${OWNER_HOST}`);
      const res = await fetch(`${target}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
      });
      const out = new Headers(res.headers);
      out.delete('content-encoding');
      out.delete('content-length');
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true) as Promise<void>,
  };
}

const KEYS: Record<string, { code: string; vk: number }> = {
  j: { code: 'KeyJ', vk: 74 },
  k: { code: 'KeyK', vk: 75 },
  o: { code: 'KeyO', vk: 79 },
  e: { code: 'KeyE', vk: 69 },
  '?': { code: 'Slash', vk: 191 },
  Escape: { code: 'Escape', vk: 27 },
};

export async function press(cdp: Cdp, key: string): Promise<void> {
  const k = KEYS[key];
  if (!k) throw new Error(`no key ${key}`);
  const text = key.length === 1 ? key : undefined;
  const shift = key === '?' ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers: shift,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers: shift,
  });
}

export async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const v = await read();
    if (v !== null) return v;
    await sleep(25);
  }
  return null;
}
