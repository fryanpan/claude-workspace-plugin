#!/usr/bin/env bun
/**
 * Runs the plugin's shipped mock render check against a real board server.
 *
 * Three mocks, each served the way a reader gets it — host page, sandboxed
 * frame, widget injected into the frame:
 *   - one that fits a phone,
 *   - one with a 1000px-wide table, which scrolls sideways at 430,
 *   - the fitting one again, from a server that has no widget build, so the
 *     widget never appears.
 * The check is spawned as a separate process with `node`, exactly as the skill
 * tells an agent in another repository to run it.
 *
 * Spawned by `check-mock-render.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the check's own output.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';

export interface CheckRun {
  status: number | null;
  /** The last line the check printed, parsed. */
  verdict: {
    pass: boolean;
    results: Array<{ size: string; pass: boolean; failures: string[] }>;
  } | null;
  stderr: string;
}

export interface RenderReading {
  fits: CheckRun;
  wide: CheckRun;
  noWidget: CheckRun;
}

const CHECK = join(import.meta.dirname, '../skills/building-a-mock/check-mock-render.mjs');

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harborlight berths</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

const FITS = page('<h1>Harborlight berths</h1><p>Riverbend: 3 free. Saltmarsh: full.</p>');
const WIDE = page(
  '<h1>Harborlight berths</h1><table style="width:1000px"><tr><td>Riverbend</td><td>Saltmarsh</td></tr></table>',
);

async function buildWidget(dist: string): Promise<void> {
  const src = (f: string) => join(import.meta.dirname, '../../widget/src', f);
  const built = await Bun.build({
    entrypoints: [
      src('widget-iife.ts'),
      src('mockup-live.ts'),
      src('mock-bridge.ts'),
      src('mock-host.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
}

/** A board server holding one mock per page given; answers each mock's URL. */
async function serve(
  dir: string,
  name: string,
  widgetDistDir: string | undefined,
  mocks: Record<string, string>,
): Promise<{ handle: ServerHandle; urls: Record<string, string> }> {
  const handle = createServer({
    port: 0,
    dataDir: join(dir, `data-${name}`),
    widgetDistDir,
    requireSignInToWrite: false,
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const agent = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const ws = (
    (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
      workspace: { id: string };
    }
  ).workspace.id;
  const urls: Record<string, string> = {};
  for (const [key, html] of Object.entries(mocks)) {
    const file = join(dir, `${name}-${key}.html`);
    writeFileSync(file, html);
    const docId = String(
      (await post(`/workspaces/${ws}/docs`, { docId: key, type: 'mockup', sourceUrl: file })).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId });
    urls[key] = `${base}/workspaces/${ws}/mockups/${docId}`;
  }
  return { handle, urls };
}

/** Async, so the servers in this process keep answering while the check runs. */
function runCheck(url: string, out: string): Promise<CheckRun> {
  const args = [CHECK, '--url', url, '--out', out, '--chrome', resolveChromeBin(undefined)];
  const child = spawn('node', [...args, '--timeout', '15000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  return new Promise((resolve) => {
    child.on('close', (status) => {
      const last = stdout.trim().split('\n').at(-1) ?? '';
      let verdict: CheckRun['verdict'] = null;
      try {
        verdict = JSON.parse(last) as CheckRun['verdict'];
      } catch {
        verdict = null;
      }
      resolve({ status, verdict, stderr });
    });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-render-check-'));
  const handles: ServerHandle[] = [];
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const withWidget = await serve(dir, 'board', dist, { fits: FITS, wide: WIDE });
    handles.push(withWidget.handle);
    const bare = await serve(dir, 'bare', undefined, { fits: FITS });
    handles.push(bare.handle);
    const reading: RenderReading = {
      fits: await runCheck(withWidget.urls.fits ?? '', join(dir, 'fits')),
      wide: await runCheck(withWidget.urls.wide ?? '', join(dir, 'wide')),
      noWidget: await runCheck(bare.urls.fits ?? '', join(dir, 'bare')),
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    for (const h of handles) await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
