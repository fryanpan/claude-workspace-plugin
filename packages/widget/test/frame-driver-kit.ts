/**
 * What the headless drivers share: the widget built from source, a poll, and
 * the two surfaces a page's content is read on — the page itself, or a mock's
 * sandboxed frame through its own CDP session — with a real mouse tap on
 * either. Used by `edit-mode-driver.ts`, `suggest-driver.ts` and
 * `page-link-driver.ts`.
 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { type Cdp, sleep } from '../../../scripts/headless-chrome.ts';

export { sleep };

export async function buildWidget(dist: string): Promise<void> {
  const src = (f: string) => join(import.meta.dirname, '../src', f);
  const built = await Bun.build({
    entrypoints: [
      src('widget-iife.ts'),
      src('mockup-live.ts'),
      src('mic-entry.ts'),
      src('voice/voice-entry.ts'),
      src('edit/edit-entry.ts'),
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
  renameSync(join(dist, 'mic-entry.js'), join(dist, 'mic.js'));
  renameSync(join(dist, 'voice-entry.js'), join(dist, 'voice.js'));
  renameSync(join(dist, 'edit-entry.js'), join(dist, 'edit.js'));
}

export async function poll<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** Where the page's own content is evaluated: the page itself, or the
 *  sandboxed frame's CDP session. */
export interface Surface {
  eval(expr: string): Promise<unknown>;
  /** Page coordinates of the surface's viewport origin. */
  offset(): Promise<{ x: number; y: number }>;
}

export function pageSurface(cdp: Cdp): Surface {
  return { eval: (e) => cdp.evaluate(e), offset: async () => ({ x: 0, y: 0 }) };
}

/** `marker` is an expression true only in the frame holding the page. */
export function frameSurface(cdp: Cdp, sessions: string[], marker: string): Surface {
  const inFrame = async (expression: string): Promise<unknown> => {
    for (const sessionId of [...sessions]) {
      const r = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => { if (!(${marker})) return '__none__'; return (${expression}); })()`,
            returnByValue: true,
            awaitPromise: true,
          },
          sessionId,
        )
        .catch(() => null)) as { result?: { value?: unknown } } | null;
      const v = r?.result?.value;
      if (v !== '__none__' && r) return v;
    }
    return null;
  };
  return {
    eval: inFrame,
    offset: async () =>
      (await cdp.evaluate(
        `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
      )) as { x: number; y: number },
  };
}

export async function frameSessions(cdp: Cdp): Promise<string[]> {
  const sessions: string[] = [];
  cdp.on('Target.attachedToTarget', (p) => {
    const sessionId = p.sessionId as string;
    if ((p.targetInfo as { type?: string } | undefined)?.type === 'iframe') {
      sessions.push(sessionId);
    }
    void cdp
      .send('Runtime.enable', {}, sessionId)
      .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId))
      .catch(() => {});
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const i = sessions.indexOf(p.sessionId as string);
    if (i >= 0) sessions.splice(i, 1);
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return sessions;
}

/** The centre of a node, in page coordinates. `find` is an expression for
 *  the node on the surface. */
export async function centre(s: Surface, find: string): Promise<{ x: number; y: number } | null> {
  const r = (await s.eval(
    `(() => { const e = ${find}; if (!e) return null; const b = e.getBoundingClientRect(); if (!b.width) return null; return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  )) as { x: number; y: number } | null;
  if (!r) return null;
  const o = await s.offset();
  return { x: r.x + o.x, y: r.y + o.y };
}

export async function tap(cdp: Cdp, s: Surface, find: string, what: string): Promise<void> {
  const at = await poll(what, () => centre(s, find));
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

export async function reload(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}
