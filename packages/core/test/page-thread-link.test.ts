import { describe, expect, it } from 'vitest';
import { pageThreadHref, withoutBoardParams } from '../src/page-thread-link.ts';

describe('pageThreadHref', () => {
  const APP = '/workspaces/w-harbor/apps/d-site/';

  it("opens an app thread's page, with the thread in place of the frame flag", () => {
    expect(pageThreadHref(APP, 't1', `${APP}bike/?day=sun&cw-frame=1#map`)).toBe(
      `${APP}bike/?day=sun&thread=t1#map`,
    );
  });

  it('keeps the form of the doc link it was given', () => {
    expect(pageThreadHref(`https://board.test${APP}`, 't1', `${APP}bike/?cw-frame=1`)).toBe(
      `https://board.test${APP}bike/?thread=t1`,
    );
  });

  it('opens the doc itself without a page, or for a page outside the doc', () => {
    for (const page of [
      undefined,
      'https://elsewhere.test/',
      '//elsewhere.test/',
      '/workspaces/w-harbor/docs/x',
    ]) {
      expect(pageThreadHref(`https://board.test${APP}`, 't1', page), String(page)).toBe(
        `https://board.test${APP}?thread=t1`,
      );
    }
    expect(pageThreadHref('/workspaces/w-harbor/mockups/d-mock', 't 2')).toBe(
      '/workspaces/w-harbor/mockups/d-mock?thread=t%202',
    );
  });

  it("drops a stale thread from the page's query", () => {
    expect(pageThreadHref(APP, 't1', `${APP}?thread=t0&a=1`)).toBe(`${APP}?a=1&thread=t1`);
    expect(withoutBoardParams('?cw-frame=1&thread=x')).toBe('');
  });
});
