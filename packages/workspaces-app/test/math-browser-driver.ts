#!/usr/bin/env bun
/**
 * Mounts a doc without math and then one with it in the real editor, in
 * headless Chrome, and prints one JSON reading of what was fetched and drawn.
 *
 * Run by `math-browser.test.ts`; a separate Bun process because the page is
 * bundled by `Bun.build` and served by `Bun.serve`, and vitest runs under
 * node. KaTeX is served from a build of the same `katex-entry.ts` the app
 * build uses, under the same `/app/katex/` path, and every request for it is
 * counted on the server side as well as read from the page's own resource
 * timings.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
  resolveRunId,
} from '../../../scripts/ui-shot-lib.ts';
import type { Reading } from './math-browser-reading.ts';

export const NO_MATH = 'No equations here, and it costs $5 and $10.\n\n```\n$$\n```\n';
export const WITH_MATH = [
  'Energy $x_e$ and $a*b$ and $c*d$.',
  '',
  '$$',
  '\\frac{a}{b} = x_e',
  '$$',
  '',
  'Hostile: $\\href{javascript:alert(1)}{click}$ and $\\url{javascript:alert(2)}$.',
  '',
  'Broken: $\\frac{a$.',
  '',
].join('\n');

const pkg = join(import.meta.dir, '..');
const requireFromPkg = createRequire(join(pkg, 'package.json'));
const katexDist = dirname(requireFromPkg.resolve('katex/dist/katex.min.css'));

async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  return (await built.outputs[0]?.text()) ?? '';
}

async function poll<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (v !== null) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const page = await bundle(join(import.meta.dir, 'math-browser-page.ts'));
const katex = await bundle(join(pkg, 'src', 'katex-entry.ts'));
const katexRequests: string[] = [];
const JS = { 'content-type': 'text/javascript' };
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/page.js') return new Response(page, { headers: JS });
    if (path === '/styles.css') return new Response(Bun.file(join(pkg, 'src', 'styles.css')));
    if (path.startsWith('/app/katex/')) {
      katexRequests.push(path);
      const rel = path.slice('/app/katex/'.length);
      if (rel === 'katex.js') return new Response(katex, { headers: JS });
      if (rel === 'katex.min.css' || /^fonts\/KaTeX_[\w-]+\.woff2$/.test(rel)) {
        return new Response(Bun.file(join(katexDist, rel)));
      }
      return new Response('not found', { status: 404 });
    }
    return new Response(
      `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><body><script type="module" src="/page.js"></script></body>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Cdp | undefined;
let reading: Reading | undefined;
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${resolveRunId()}math`,
    (b) => {
      browser = b;
    },
  );
  const c = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  cdp = c;
  await c.send('Page.enable');
  const loaded = c.once('Page.loadEventFired');
  await c.send('Page.navigate', { url: origin });
  await withTimeout(loaded, 20_000, 'page load');
  await poll(
    async () => ((await c.evaluate(`typeof window.cwMathMount === 'function'`)) ? true : null),
    'the page bundle',
  );

  // The doc without math. Deciding whether to fetch happens while the editor
  // builds its first decorations, synchronously inside the mount, so once
  // the paragraph is on screen the decision is made.
  await c.evaluate(`window.cwMathMount(${JSON.stringify(NO_MATH)})`);
  await poll(
    async () => ((await c.evaluate(`!!document.querySelector('.ProseMirror p')`)) ? true : null),
    'the doc without math',
  );
  const requestsBefore = katexRequests.length;
  const before = (await c.evaluate(`({
    katex: document.querySelectorAll('.katex').length,
    resources: performance.getEntriesByType('resource').filter((e) => e.name.includes('/app/katex/')).length,
    stylesheets: document.querySelectorAll('link[href*="katex"]').length,
  })`)) as Omit<Reading['before'], 'requests'>;

  // The doc with math, in the same page: the positive control for the read
  // above, since the same page now has to fetch.
  await c.evaluate(`document.body.querySelectorAll('#editor').forEach((e) => e.remove())`);
  await c.evaluate(`window.cwMathMount(${JSON.stringify(WITH_MATH)})`);
  await poll(
    async () =>
      ((await c.evaluate(
        `document.querySelectorAll('.cw-math .katex').length >= 5 && !!document.querySelector('.cm-math-display .katex-display')`,
      )) as boolean)
        ? true
        : null,
    'KaTeX to draw',
  );
  const after = (await c.evaluate(`(() => {
    const all = Array.from(document.querySelectorAll('.ProseMirror *'));
    return {
      katex: document.querySelectorAll('.cw-math .katex').length,
      display: document.querySelectorAll('.cm-math-display .katex-display').length,
      scriptLinks: all.filter((el) => Array.from(el.attributes).some((a) => /href$/i.test(a.name) && /^\\s*javascript:/i.test(a.value))).length,
      errors: document.querySelectorAll('.katex-error').length,
      errorText: document.querySelector('.katex-error')?.textContent ?? '',
    };
  })()`)) as Omit<Reading['after'], 'requests' | 'openedOnClick'>;

  // A press on the first equation opens its TeX.
  const at = (await c.evaluate(`(() => {
    const r = document.querySelector('.cw-math').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number };
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
  const openedOnClick = await poll(
    async () =>
      (await c.evaluate(`document.querySelector('.cw-math-open')?.textContent ?? null`)) as
        | string
        | null,
    'the clicked equation to open',
  );
  reading = {
    before: { ...before, requests: requestsBefore },
    after: { ...after, requests: [...new Set(katexRequests)].sort(), openedOnClick },
  };
} finally {
  cdp?.close();
  if (browser) await stopBrowser(browser.proc, browser.profile);
  server.stop(true);
}
process.stdout.write(`${JSON.stringify(reading)}\n`);
process.exit(0);
