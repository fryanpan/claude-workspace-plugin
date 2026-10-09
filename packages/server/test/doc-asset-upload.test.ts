import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES } from '../src/doc-image-store.ts';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A pasted, dropped or picked image is stored in `images/` beside the bound
 * `.md`, under a name nothing else holds, and the `![](…)` line the editor
 * writes for it reaches the file on disk.
 */
const MD = '# Saltmarsh\n\nA paragraph.\n';

async function bootWithDoc(opts: { requireSignInToWrite: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'doc-asset-upload-'));
  const docDir = join(root, 'saltmarsh');
  mkdirSync(docDir);
  writeFileSync(join(docDir, 'doc.md'), MD);
  const handle = createServer({ port: 0, dataDir: join(root, 'data'), ...opts });
  const base = `http://127.0.0.1:${handle.port}`;
  const ws = await seedBoard(base);
  const created = await fetch(`${base}/workspaces/${ws}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      docId: 'saltmarsh',
      type: 'markdown',
      sourceUrl: join(docDir, 'doc.md'),
    }),
  });
  expect(created.ok).toBe(true);
  return { root, docDir, handle, base, ws };
}

describe('POST …/docs/<id>/assets', () => {
  let s: Awaited<ReturnType<typeof bootWithDoc>>;
  beforeAll(async () => {
    s = await bootWithDoc({ requireSignInToWrite: false });
  });
  afterAll(async () => {
    await s.handle.stop();
    rmSync(s.root, { recursive: true, force: true });
  });

  const upload = (
    body: Uint8Array<ArrayBuffer>,
    name = 'Harborlight Chart.png',
    type = 'image/png',
  ) =>
    fetch(`${s.base}/workspaces/${s.ws}/docs/saltmarsh/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  it('stores the image in images/ beside the .md and the line reaches disk', async () => {
    const png = tinyPng(70);
    const res = await upload(png);
    expect(res.status).toBe(201);
    const { src } = (await res.json()) as { src: string };
    expect(src).toMatch(/^images\/harborlight-chart-[0-9a-f]{8}\.png$/);
    expect(new Uint8Array(readFileSync(join(s.docDir, src)))).toEqual(png);
    // The stored path is the one the read route serves.
    const served = await fetch(`${s.base}/workspaces/${s.ws}/docs/saltmarsh/assets/${src}`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    // The editor inserts `![](src)`; whatever writes the live doc, the line
    // lands in the .md exactly as written.
    const md = `${MD}\n![](${src})\n`;
    const put = await fetch(`${s.base}/workspaces/${s.ws}/docs/saltmarsh/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: md, confirmOverwriteHumanEdits: true }),
    });
    expect(put.status).toBe(200);
    await waitForFileToBe(join(s.docDir, 'doc.md'), md);
  });

  it('never overwrites: the same name twice keeps both files', async () => {
    const a = (await (await upload(tinyPng(10), 'same.png')).json()) as { src: string };
    const b = (await (await upload(tinyPng(20), 'same.png')).json()) as { src: string };
    expect(a.src).not.toBe(b.src);
    expect(new Uint8Array(readFileSync(join(s.docDir, a.src)))).toEqual(tinyPng(10));
    expect(new Uint8Array(readFileSync(join(s.docDir, b.src)))).toEqual(tinyPng(20));
  });

  it('judges the type by the bytes, not the header or the name', async () => {
    const text = new TextEncoder().encode('not an image at all');
    expect((await upload(text, 'evil.png', 'image/png')).status).toBe(415);
    // An SVG can carry script; only raster images are taken.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect((await upload(svg, 'a.svg', 'image/svg+xml')).status).toBe(415);
  });

  it('refuses an image over the cap and writes nothing', async () => {
    const before = readdirSync(join(s.docDir, 'images')).length;
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(tinyPng());
    expect((await upload(big)).status).toBe(413);
    expect(readdirSync(join(s.docDir, 'images')).length).toBe(before);
  });
});

describe('an images/ that leads out of the doc folder', () => {
  it('is refused, and nothing is written where it points', async () => {
    const s = await bootWithDoc({ requireSignInToWrite: false });
    const elsewhere = join(s.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(s.docDir, 'images'));
    const res = await fetch(`${s.base}/workspaces/${s.ws}/docs/saltmarsh/assets?name=a.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: tinyPng(),
    });
    expect(res.status).toBe(409);
    expect(readdirSync(elsewhere)).toEqual([]);
    await s.handle.stop();
    rmSync(s.root, { recursive: true, force: true });
  });
});

describe('who may upload', () => {
  let s: Awaited<ReturnType<typeof bootWithDoc>>;
  beforeAll(async () => {
    s = await bootWithDoc({ requireSignInToWrite: true });
  });
  afterAll(async () => {
    await s.handle.stop();
    rmSync(s.root, { recursive: true, force: true });
  });

  const post = (headers: Record<string, string>) =>
    fetch(`${s.base}/workspaces/${s.ws}/docs/saltmarsh/assets?name=a.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...headers },
      body: tinyPng(),
    });

  it('refuses a browser that has not signed in, and stores nothing', async () => {
    const res = await post({ origin: s.base });
    expect(res.status).toBe(401);
    expect(existsSync(join(s.docDir, 'images'))).toBe(false);
  });

  it('takes the same upload from the operator’s agent (the control)', async () => {
    expect((await post({})).status).toBe(201);
  });
});

describe('share scope for an upload', () => {
  const BOARD: ShareTarget = { workspaceId: 'ws-1' };
  const owners = (id: string) => (id === 'saltmarsh' ? ['ws-1'] : []);

  it('admits a POST on a doc the share admits, as the live socket is', () => {
    expect(shareScopeAllows('/workspaces/ws-1/docs/saltmarsh/assets', 'POST', BOARD, owners)).toBe(
      true,
    );
    expect(shareScopeAllows('/workspaces/ws-1/docs/saltmarsh/y', 'GET', BOARD, owners)).toBe(true);
  });

  it('refuses a doc off the board and a write to a file path', () => {
    expect(shareScopeAllows('/workspaces/ws-1/docs/riverbend/assets', 'POST', BOARD, owners)).toBe(
      false,
    );
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/saltmarsh/assets/a.png', 'PUT', BOARD, owners),
    ).toBe(false);
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/saltmarsh/assets/a.png', 'POST', BOARD, owners),
    ).toBe(false);
  });
});
