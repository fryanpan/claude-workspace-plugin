/**
 * `page-thread.ts` on its own: which address an app page's thread is pinned
 * to, and which calls it refuses before anything is written.
 */
import { describe, expect, it } from 'bun:test';
import { appFrameUrl, pageThreadPlan } from '../src/page-thread.ts';

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
