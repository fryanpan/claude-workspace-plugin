#!/usr/bin/env bun
/**
 * The link an agent hands a person for a thread on an attached app's page,
 * opened in headless Chromium against a real board server.
 *
 * The dev server answers `/transportation/bike` with a redirect to
 * `/transportation/bike/`, as a static site does. The agent opens one thread
 * with each spelling of the page. The driver reads the address the widget in
 * the frame keys a person's thread by, then opens the first thread's link:
 * both pins must be drawn, and that thread's popover must be open.
 *
 * Spawned by `page-link-browser.test.ts`, which reads the JSON it prints.
 * `PAGE_LINK_SHOTS=<dir>` also writes screenshots at 1180x820 and 430x932.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget, frameSessions, frameSurface, poll, reload } from './frame-driver-kit.ts';

export interface PageLinkRun {
  /** What the widget in the frame keys a person's thread by, on the plain page. */
  personKey: string;
  /** The two agent threads' stored page, in creation order. */
  agentKeys: string[];
  /** The first thread's link, as a path on the board. */
  link: string;
  /** After opening the link: the widget's key, the pins drawn, the popover's text. */
  opened: { key: string; pins: string[]; popover: string };
  ids: { slashless: string; framed: string };
}

const SHADOW = `document.querySelector('claude-feedback-widget')?.shadowRoot`;
const KEY = `document.querySelector('claude-feedback-widget')?.getContext().url ?? null`;
const PINS = `[...document.querySelectorAll('.cfw-pin')].map((p) => p.dataset.threadId)`;
const POPOVER = `${SHADOW}?.querySelector('.thread-popover')?.textContent ?? null`;

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style></head><body>${body}</body></html>`;

const step = (what: string): void => {
  process.stderr.write(`[page-link-driver] ${what}\n`);
};

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'page-link-'));
  const shots = process.env.PAGE_LINK_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;

    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/transportation/bike') {
          return new Response(null, {
            status: 301,
            headers: { location: '/transportation/bike/' },
          });
        }
        return new Response(
          path === '/transportation/bike/'
            ? page(
                '<h1 id="bike">Riverbend bike lanes</h1>' +
                  '<p id="ferry">The Saltmarsh ferry takes bikes.</p>',
              )
            : page('<h1>Harborlight home</h1>'),
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      },
    });
    const app = String(
      (
        await post(`/workspaces/${ws}/apps`, {
          docId: 'harborlight-app',
          origin: `http://127.0.0.1:${dev.port}/`,
        })
      ).docId,
    );
    type Made = {
      thread: { id: string; anchor: { context?: { url?: string } } };
      threadUrl: string;
    };
    const byFind = async (body: Record<string, unknown>) =>
      (await post(`/workspaces/${ws}/docs/${app}/threads/by_find`, {
        author: agent,
        ...body,
      })) as unknown as Made;
    const slashless = await byFind({
      text: 'Which lanes are protected?',
      find: 'Riverbend bike lanes',
      path: '/transportation/bike',
    });
    const framed = await byFind({
      text: 'Every ferry, or some?',
      find: 'The Saltmarsh ferry takes bikes.',
      path: '/transportation/bike/?cw-frame=1',
    });
    const linkUrl = new URL(slashless.threadUrl);
    const link = linkUrl.pathname + linkUrl.search + linkUrl.hash;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `page-link-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const size = (width: number, height: number) =>
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 1100,
      });
    const shot = async (name: string) => {
      if (!shots) return;
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      writeFileSync(join(shots, name), Buffer.from(png.data, 'base64'));
    };
    const frame = frameSurface(cdp, sessions, "document.getElementById('bike')");

    step('open the page as a person would, without the slash');
    await size(1180, 820);
    await reload(cdp, `${base}/workspaces/${ws}/apps/${app}/transportation/bike`);
    const personKey = String(await poll('the widget in the frame', () => frame.eval(KEY)));

    const openLink = async (): Promise<PageLinkRun['opened']> => {
      await reload(cdp, `${base}${link}`);
      const popover = String(
        await poll('the linked thread open', async () => {
          const text = (await frame.eval(POPOVER)) as string | null;
          return text?.includes('Which lanes are protected?') ? text : null;
        }),
      );
      const pins = (await poll('both pins', async () => {
        const ids = (await frame.eval(PINS)) as string[] | null;
        return ids && ids.length >= 2 ? ids : null;
      })) as string[];
      return { key: String(await frame.eval(KEY)), pins, popover };
    };
    step('open the link');
    const opened = await openLink();
    await shot('link-1180.png');
    await size(430, 932);
    await openLink();
    await shot('link-430.png');
    cdp.close();

    const run: PageLinkRun = {
      personKey,
      agentKeys: [slashless, framed].map((m) => m.thread.anchor.context?.url ?? ''),
      link,
      opened,
      ids: { slashless: slashless.thread.id, framed: framed.thread.id },
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 150s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 150_000).unref();
await main();
process.exit(0);
