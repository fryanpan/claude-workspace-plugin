#!/usr/bin/env bun
/**
 * Taps a comment's highlight in the real editor, in headless Chrome, selects
 * all, and presses Delete or Backspace; prints one JSON reading per gesture
 * of how much of the doc's text survived.
 *
 * The tap puts the caret in the doc (`placeCaretAtPoint`), so the select-all
 * that follows takes the whole doc, and before the guard a Delete then left
 * nothing. Tapping the comment's card, the chart, or the highlight without a
 * select-all left the doc whole when this was being found, so they are not
 * repeated here.
 *
 * Run by `doc-wipe-browser.test.ts`; a separate Bun process for the reason
 * `math-browser-driver.ts` gives.
 */
import { join } from 'node:path';
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
import type { WipeReading } from './doc-wipe-browser-reading.ts';
import { plotChartSource } from './fixtures/plot-chart.ts';

const DOC = [
  '# Riverbend school trips',
  '',
  'Walking fell every year since 2005, and biking held.',
  '',
  plotChartSource(),
  '',
  'The goal line is the district target for Harborlight.',
  '',
].join('\n');
/** The words each comment is anchored to: one in prose, one in the chart. */
const WORDS = ['biking held', 'Trips a year'];

interface Gesture {
  name: string;
  /** CSS selector of the element tapped. */
  target: string;
  selectAll: boolean;
  key: 'Backspace' | 'Delete';
}

const PROSE_COMMENT = '.ProseMirror p .thread-range';
const GESTURES: Gesture[] = [];
for (const key of ['Backspace', 'Delete'] as const) {
  GESTURES.push(
    { name: `prose comment, select all, ${key}`, target: PROSE_COMMENT, selectAll: true, key },
    {
      name: `chart comment, select all, ${key}`,
      target: '.mdx-source .thread-range',
      selectAll: true,
      key,
    },
    { name: `prose comment, ${key}`, target: PROSE_COMMENT, selectAll: false, key },
    { name: `plain prose, select all, ${key}`, target: '.ProseMirror h1', selectAll: true, key },
  );
}

const pkg = join(import.meta.dir, '..');

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

const KEY_CODES = { Backspace: 8, Delete: 46 } as const;
/** CDP's modifier bits: 4 is Meta, 2 is Control. */
const MOD = process.platform === 'darwin' ? 4 : 2;

const page = await bundle(join(import.meta.dir, 'doc-wipe-browser-page.ts'));
const JS = { 'content-type': 'text/javascript' };
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/page.js') return new Response(page, { headers: JS });
    if (path === '/styles.css') return new Response(Bun.file(join(pkg, 'src', 'styles.css')));
    if (path === '/doc.css') return new Response(Bun.file(join(pkg, 'src', 'doc.css')));
    return new Response(
      `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/doc.css"><body><script type="module" src="/page.js"></script></body>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Cdp | undefined;
const readings: WipeReading[] = [];
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${resolveRunId()}wipe`,
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
    async () => ((await c.evaluate(`typeof window.cwWipeMount === 'function'`)) ? true : null),
    'the page bundle',
  );
  const read = async () =>
    (await c.evaluate('window.cwWipeRead()')) as { text: string; selection: string };
  for (const g of GESTURES) {
    await c.evaluate(`window.cwWipeMount(${JSON.stringify(DOC)}, ${JSON.stringify(WORDS)})`);
    const at = await poll(
      async () =>
        (await c.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(g.target)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.left + Math.min(r.width / 2, 30), y: r.top + r.height / 2 };
        })()`)) as { x: number; y: number } | null,
      g.target,
    );
    const before = (await read()).text.length;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', {
        type,
        x: at.x,
        y: at.y,
        button: 'left',
        clickCount: 1,
      });
    }
    // The editor reads the caret on `selectionchange`; wait for it to land
    // somewhere other than the start the mount left it at.
    await poll(async () => ((await read()).selection.endsWith(' 1-1') ? null : true), 'the caret');
    if (g.selectAll) {
      // Cmd on a Mac, Ctrl elsewhere: the editor's Mod-a follows the platform,
      // and CI runs on Linux.
      const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MOD };
      await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...a, commands: ['selectAll'] });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...a });
      await poll(
        async () => ((await read()).selection.startsWith('AllSelection') ? true : null),
        'the select-all',
      );
    }
    const selection = (await read()).selection;
    const k = { key: g.key, code: g.key, windowsVirtualKeyCode: KEY_CODES[g.key] };
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    // A key the editor handles is applied before the dispatch returns; a
    // frame is the browser's turn to apply one it did not.
    await c.evaluate('new Promise((r) => requestAnimationFrame(() => r(null)))');
    readings.push({ name: g.name, before, after: (await read()).text.length, selection });
  }
} finally {
  cdp?.close();
  if (browser) await stopBrowser(browser.proc, browser.profile);
  server.stop(true);
}
process.stdout.write(`${JSON.stringify(readings)}\n`);
process.exit(0);
