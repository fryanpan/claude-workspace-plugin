import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { decodeSegments, resolveInside } from '../src/routes/doc-assets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * An image named by a path relative to a bound `.md` is served from the doc's
 * own directory tree, and nothing outside that tree is reachable through it.
 */
let WS = '';
const MD = '# Harborlight\n\n![caption](chart.png)\n\n![](img/chart.png)\n';

describe('GET …/docs/<id>/assets/<path>', () => {
  let handle: ServerHandle;
  let root: string;
  let base: string;
  const near = tinyPng(40);
  const nested = tinyPng(90);
  const outside = tinyPng(200);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-assets-'));
    const dataDir = join(root, 'data');
    const docDir = join(root, 'harborlight');
    mkdirSync(join(docDir, 'img'), { recursive: true });
    writeFileSync(join(docDir, 'doc.md'), MD);
    writeFileSync(join(docDir, 'chart.png'), near);
    writeFileSync(join(docDir, 'img', 'chart.png'), nested);
    writeFileSync(join(docDir, 'notes.txt'), 'not an image');
    writeFileSync(join(root, 'secret.png'), outside);
    symlinkSync(join(root, 'secret.png'), join(docDir, 'leak.png'));
    symlinkSync(join(docDir, 'notes.txt'), join(docDir, 'renamed.png'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'harborlight',
        type: 'markdown',
        sourceUrl: join(docDir, 'doc.md'),
      }),
    });
    expect(created.ok).toBe(true);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path: string, method = 'GET') =>
    fetch(`${base}/workspaces/${WS}/docs/harborlight/assets/${path}`, { method });

  it('serves an image beside the .md, byte for byte', async () => {
    const res = await get('chart.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(near);
  });

  it('serves an image in a folder under the .md', async () => {
    const res = await get('img/chart.png');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(nested);
  });

  it('refuses every spelling of a climb out of the folder', async () => {
    for (const p of ['..%2Fsecret.png', '%2E%2E%2Fsecret.png', 'img%2F..%2F..%2Fsecret.png']) {
      const res = await get(p);
      expect(res.status, p).toBe(400);
    }
    // An absolute path in one segment.
    expect((await get(`${encodeURIComponent(join(root, 'secret.png'))}`)).status).toBe(400);
  });

  it('refuses a symlink that lands outside the folder', async () => {
    const res = await get('leak.png');
    expect(res.status).toBe(404);
    expect(new Uint8Array(await res.arrayBuffer())).not.toEqual(outside);
  });

  it('refuses a file that is not an image, by name or by where its link lands', async () => {
    expect((await get('notes.txt')).status).toBe(415);
    expect((await get('renamed.png')).status).toBe(415);
  });

  it('answers 404 for a missing image and 405 for a write', async () => {
    expect((await get('missing.png')).status).toBe(404);
    expect((await get('chart.png', 'POST')).status).toBe(405);
  });

  it('writes the relative paths back to the .md exactly as written', async () => {
    const md = join(root, 'harborlight', 'doc.md');
    expect(readFileSync(md, 'utf8')).toBe(MD);
    // An edit elsewhere forces a write-back of the whole doc, images included.
    const res = await fetch(`${base}/workspaces/${WS}/docs/harborlight/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Harborlight', replace: 'Riverbend' }),
    });
    expect(res.status).toBe(200);
    await waitForFileToBe(md, MD.replace('Harborlight', 'Riverbend'));
  });
});

describe('decodeSegments / resolveInside', () => {
  it('decodes each segment and refuses one that could climb', () => {
    expect(decodeSegments('img/a%20b.png')).toEqual(['img', 'a b.png']);
    for (const raw of [
      '',
      'a//b.png',
      './a.png',
      '../a.png',
      'a%2Fb.png',
      'a%5Cb.png',
      '%E0.png',
    ]) {
      expect(decodeSegments(raw), raw).toBeNull();
    }
  });

  it('resolves only a file under the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-assets-unit-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.png'), tinyPng());
    expect(resolveInside(dir, ['sub', 'a.png'])).toEndWith(join('sub', 'a.png'));
    expect(resolveInside(dir, ['sub'])).toBeNull();
    writeFileSync(join(dir, 'b.png'), tinyPng());
    expect(resolveInside(join(dir, 'sub'), ['..', 'b.png'])).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('share scope for a doc’s images', () => {
  const BOARD: ShareTarget = { workspaceId: 'ws-1' };
  const owners = (id: string) => (id === 'harborlight' ? ['ws-1'] : []);

  it('admits a GET on a doc the share already admits', () => {
    const p = '/workspaces/ws-1/docs/harborlight/assets/chart.png';
    expect(shareScopeAllows(p, 'GET', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(p, 'HEAD', BOARD, owners)).toBe(true);
    // The doc's text is admitted by the same rule — the control that the
    // board, doc and owner fixtures above are a real share.
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/harborlight/content', 'GET', BOARD, owners),
    ).toBe(true);
  });

  it('refuses a write, a doc off the board, and a different board', () => {
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/harborlight/assets/a.png', 'POST', BOARD, owners),
    ).toBe(false);
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/riverbend/assets/a.png', 'GET', BOARD, owners),
    ).toBe(false);
    expect(
      shareScopeAllows('/workspaces/ws-2/docs/harborlight/assets/a.png', 'GET', BOARD, owners),
    ).toBe(false);
  });
});
