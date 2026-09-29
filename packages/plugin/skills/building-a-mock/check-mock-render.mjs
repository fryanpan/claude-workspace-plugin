#!/usr/bin/env node
/**
 * Render a served mock the way its reader will, and fail on the two defects a
 * local render cannot show: the comment widget the board injects is missing or
 * hidden, or the mock scrolls sideways on a phone.
 *
 * Usage:
 *   node check-mock-render.mjs --url <the mock's URL on the board> [--out <dir>]
 *        [--sizes 1900x1200,1180x820,430x932] [--timeout <ms>] [--chrome <path>]
 *
 * Exit 0: the widget showed at every size and nothing scrolled sideways at the
 * narrowest. Exit 1: a check failed; each line says which and where. Exit 2:
 * the check could not run (bad arguments, no Chrome, Chrome never came up).
 *
 * The page is loaded in a throwaway headless Chrome with its own profile, never
 * in a browser a person is using. The URL must open without a sign-in, so use
 * the board's local address (the served mock sits behind a sign-in on a public
 * host, and a sign-in page has no widget). A screenshot per size lands in
 * --out; the last line printed is the whole verdict as JSON.
 *
 * It ships with the plugin and depends on nothing but Node 22+ (or Bun) and a
 * Chrome or Chromium binary, so it runs from any repository.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDGET_TAG = 'claude-feedback-widget';
const DEFAULT_SIZES = '1900x1200,1180x820,430x932';
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const USAGE =
  'usage: node check-mock-render.mjs --url <mock url> [--out <dir>] [--sizes WxH,...] [--timeout <ms>] [--chrome <path>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { url: '', out: '', sizes: DEFAULT_SIZES, timeout: 20000, chrome: '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') throw new UsageError(USAGE);
    const key = {
      '--url': 'url',
      '--out': 'out',
      '--sizes': 'sizes',
      '--timeout': 'timeout',
      '--chrome': 'chrome',
    }[flag];
    if (!key || value === undefined)
      throw new UsageError(`unknown or incomplete argument ${flag}\n${USAGE}`);
    opts[key] = key === 'timeout' ? Number(value) : value;
    i++;
  }
  if (!/^https?:\/\//.test(opts.url))
    throw new UsageError(`--url must be an http(s) address\n${USAGE}`);
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0)
    throw new UsageError('--timeout must be a positive number of ms');
  opts.sizes = opts.sizes.split(',').map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (!m) throw new UsageError(`bad size "${s}", expected WxH`);
    return { width: Number(m[1]), height: Number(m[2]) };
  });
  return opts;
}

function findChrome(explicit) {
  const found = [explicit, process.env.CHROME_BIN, ...CHROME_CANDIDATES].find(
    (p) => p && existsSync(p),
  );
  if (!found) throw new UsageError('no Chrome found: pass --chrome <path> or set CHROME_BIN');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client on the browser socket; `session` addresses an attached target. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message));
        else p?.resolve(m.result);
      } else {
        for (const fn of this.listeners) fn(m.method, m.params, m.sessionId);
      }
    };
  }
  static open(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`could not open ${url}`));
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

async function launch(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'cw-mock-check-'));
  const extra = (process.env.CW_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      ...extra,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  // Chrome keeps writing its profile until it has actually exited, so wait
  // for the exit before removing it, and never let cleanup fail the verdict.
  const exited = new Promise((r) => proc.once('exit', r));
  const stop = async () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp profile is the OS temp reaper's to collect.
    }
  };
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n');
      if (port && path) return { cdp: await Cdp.open(`ws://127.0.0.1:${port}${path}`), stop };
    }
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  await stop();
  throw new UsageError(`Chrome never came up (${bin})`);
}

/** Runs in every document on the page: the host and the mock's own frame. */
const PROBE = `(() => {
  const w = document.querySelector(${JSON.stringify(WIDGET_TAG)});
  let widget = false;
  const root = w && w.shadowRoot;
  if (root) for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
        && getComputedStyle(el).visibility !== 'hidden') { widget = true; break; }
  }
  const se = document.scrollingElement || document.documentElement;
  return JSON.stringify({ url: location.href, widget, scrollWidth: se.scrollWidth, clientWidth: se.clientWidth });
})()`;

async function evaluate(cdp, sessionId, contextId) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression: PROBE, returnByValue: true, ...(contextId ? { contextId } : {}) },
    sessionId,
  );
  return JSON.parse(r.result.value);
}

function framesOf(tree) {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(framesOf)];
}

/** Every document the page holds, in-process frames and out-of-process ones. */
async function probeAll(cdp, pageSession, childSessions) {
  const docs = [];
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, pageSession);
  for (const frame of framesOf(frameTree)) {
    try {
      const { executionContextId } = await cdp.send(
        'Page.createIsolatedWorld',
        { frameId: frame.id, worldName: 'cw-mock-check' },
        pageSession,
      );
      docs.push(await evaluate(cdp, pageSession, executionContextId));
    } catch {
      // An out-of-process frame: read through its own session below.
    }
  }
  for (const s of childSessions) {
    try {
      docs.push(await evaluate(cdp, s));
    } catch {
      // A frame that navigated away between attach and read.
    }
  }
  return docs.filter((d) => d.url !== 'about:blank');
}

async function checkSize(cdp, opts, size, narrowest) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const children = new Set();
  cdp.on((method, params, from) => {
    if (method === 'Target.attachedToTarget' && from === sessionId) children.add(params.sessionId);
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.width <= 500 },
    sessionId,
  );
  await cdp.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId,
  );
  await cdp.send('Page.navigate', { url: opts.url }, sessionId);
  let docs = [];
  const deadline = Date.now() + opts.timeout;
  while (Date.now() < deadline) {
    docs = await probeAll(cdp, sessionId, children).catch(() => []);
    if (docs.some((d) => d.widget)) break;
    await sleep(250);
  }
  // Let late layout settle before measuring width and taking the picture.
  await sleep(500);
  docs = await probeAll(cdp, sessionId, children).catch(() => docs);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = join(opts.out, `mock-${size.width}x${size.height}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  const sideways = docs.filter((d) => d.scrollWidth > d.clientWidth + 1);
  const failures = [];
  if (!docs.some((d) => d.widget)) failures.push('widget missing or hidden');
  if (narrowest && sideways.length > 0) {
    failures.push(
      `scrolls sideways: ${sideways.map((d) => `${d.scrollWidth}px content in ${d.clientWidth}px`).join(', ')}`,
    );
  }
  return {
    size: `${size.width}x${size.height}`,
    pass: failures.length === 0,
    failures,
    screenshot: file,
    documents: docs,
  };
}

async function main() {
  let opts;
  let browser;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (typeof WebSocket !== 'function') {
      throw new UsageError('this runtime has no WebSocket: use Node 22 or newer, or Bun');
    }
    opts.out = opts.out || mkdtempSync(join(tmpdir(), 'cw-mock-shots-'));
    mkdirSync(opts.out, { recursive: true });
    browser = await launch(findChrome(opts.chrome));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const onSignal = () => {
    browser.stop().then(() => process.exit(2));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const narrow = Math.min(...opts.sizes.map((s) => s.width));
    const results = [];
    for (const size of opts.sizes) {
      const r = await checkSize(browser.cdp, opts, size, size.width === narrow);
      results.push(r);
      process.stdout.write(
        `${r.pass ? 'PASS' : 'FAIL'} ${r.size} ${r.failures.join('; ')} ${r.screenshot}\n`,
      );
    }
    const pass = results.every((r) => r.pass);
    process.stdout.write(`${JSON.stringify({ url: opts.url, pass, results })}\n`);
    return pass ? 0 : 1;
  } catch (e) {
    process.stderr.write(`check could not run: ${e.message}\n`);
    return 2;
  } finally {
    await browser.stop();
  }
}

process.exit(await main());
