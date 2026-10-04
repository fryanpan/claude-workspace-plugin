/**
 * `page-thread.ts` on its own: which address an app page's thread is pinned
 * to, and which calls it refuses before anything is written.
 */
import { describe, expect, it } from 'bun:test';
import type { ElementAnchor } from '@claude-workspaces/core';
import { appFrameUrl, pageThreadLink, pageThreadPlan, servedPath } from '../src/page-thread.ts';

const base = {
  workspaceId: 'w-harbor',
  docId: 'd-site',
  find: 'Riverbend walk',
  narrowed: false,
} as const;

describe('appFrameUrl', () => {
  it('is the address the widget in the frame reads', () => {
    expect(appFrameUrl('w-harbor', 'd-site', '/')).toBe(
      '/workspaces/w-harbor/apps/d-site/?cw-frame=1',
    );
    expect(appFrameUrl('w-harbor', 'd-site', '/calendar?month=june#week-2')).toBe(
      '/workspaces/w-harbor/apps/d-site/calendar?month=june&cw-frame=1#week-2',
    );
  });

  it('refuses a path that climbs out of the app', () => {
    expect(appFrameUrl('w-harbor', 'd-site', '/../../d-other/')).toBeNull();
  });
});

describe('pageThreadPlan', () => {
  it('pins an app thread to its page and a mock thread to no page', () => {
    const app = pageThreadPlan({ ...base, type: 'app', path: '/calendar' });
    expect(app.ok && app.anchor.context?.url).toBe(
      '/workspaces/w-harbor/apps/d-site/calendar?cw-frame=1',
    );
    const mock = pageThreadPlan({ ...base, type: 'mockup' });
    expect(mock.ok && mock.anchor.context).toBeUndefined();
  });

  it('refuses what it cannot honour, saying why', () => {
    const cases: Array<[Parameters<typeof pageThreadPlan>[0], string]> = [
      [{ ...base, type: 'app' }, 'path'],
      [{ ...base, type: 'app', path: 'calendar' }, 'path'],
      [{ ...base, type: 'mockup', path: '/x' }, 'omit path'],
      [{ ...base, type: 'mockup', narrowed: true }, 'words alone'],
      [{ ...base, type: 'mockup', find: 'x'.repeat(301) }, '300'],
      [{ ...base, type: 'mockup', suggest: { replacement: 'Riverbend walk' } }, 'suggest'],
      [{ ...base, type: 'mockup', suggest: 'Riverbend' }, 'suggest'],
    ];
    for (const [args, says] of cases) {
      const plan = pageThreadPlan(args);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toContain(says);
    }
  });

  it('carries a suggestion whole', () => {
    const plan = pageThreadPlan({ ...base, type: 'mockup', suggest: { replacement: '' } });
    expect(plan.ok && plan.suggestion).toEqual({ find: 'Riverbend walk', replacement: '' });
  });
});

describe('servedPath', () => {
  const ORIGIN = 'http://127.0.0.1:4100';
  const PREFIX = '/workspaces/w-harbor/apps/d-site/';
  /** A dev server that answers each path from `routes`: a redirect target, or a page. */
  const site = (routes: Record<string, string>) => {
    const asked: string[] = [];
    const get = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      asked.push(u.pathname + u.search);
      const to = routes[u.pathname];
      return to
        ? new Response(null, { status: 301, headers: { location: to } })
        : new Response('ok');
    }) as typeof fetch;
    return { get, asked };
  };

  it('follows the dev server to the page, keeping the query and fragment', async () => {
    const s = site({ '/bike': '/bike/' });
    expect(await servedPath(ORIGIN, PREFIX, '/bike?day=sun#map', s.get)).toBe('/bike/#map');
    expect(s.asked).toEqual(['/bike?day=sun', '/bike/']);
  });

  it("drops the board's own query before asking", async () => {
    const s = site({});
    expect(await servedPath(ORIGIN, PREFIX, '/bike/?cw-frame=1&day=sun&thread=t1', s.get)).toBe(
      '/bike/?day=sun',
    );
    expect(s.asked).toEqual(['/bike/?day=sun']);
  });

  it('reads a redirect under the board prefix as the app path after it', async () => {
    const s = site({ '/bike': `${PREFIX}bike/` });
    expect(await servedPath(ORIGIN, PREFIX, '/bike', s.get)).toBe('/bike/');
  });

  it('never follows a redirect off the app, and gives up after five', async () => {
    expect(
      await servedPath(ORIGIN, PREFIX, '/out', site({ '/out': 'http://riverbend.test/' }).get),
    ).toBe('/out');
    const loop = site({ '/a': '/b', '/b': '/a' });
    await servedPath(ORIGIN, PREFIX, '/a', loop.get);
    expect(loop.asked.length).toBe(5);
  });

  it('keeps the path as written when the app does not answer', async () => {
    const down = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await servedPath(ORIGIN, PREFIX, '/bike?cw-frame=1', down)).toBe('/bike');
  });
});

describe('pageThreadLink', () => {
  const anchor = (url?: string): ElementAnchor => ({
    kind: 'element',
    fingerprint: { tag: '*', stableAttrs: {}, classes: [], text: 'x', path: '', dataAttrs: {} },
    snippet: { text: 'x' },
    ...(url ? { context: { url } } : {}),
  });

  it("opens an app thread's page, with the thread, in place of the frame flag", () => {
    const link = pageThreadLink('https://board.test/workspaces/w-harbor/apps/d-site/', {
      id: 't1',
      anchor: anchor('/workspaces/w-harbor/apps/d-site/bike/?day=sun&cw-frame=1#map'),
    });
    expect(link).toBe(
      'https://board.test/workspaces/w-harbor/apps/d-site/bike/?day=sun&thread=t1#map',
    );
  });

  it('opens a mock with the thread', () => {
    const link = pageThreadLink('https://board.test/workspaces/w-harbor/mockups/d-mock', {
      id: 't2',
      anchor: anchor(),
    });
    expect(link).toBe('https://board.test/workspaces/w-harbor/mockups/d-mock?thread=t2');
  });
});
