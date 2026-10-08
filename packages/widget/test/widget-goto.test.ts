import { afterEach, describe, expect, it } from 'vitest';
import { goTo, takeGoTo } from '../src/widget-goto.ts';

/**
 * The thread id rides on the end of the address and comes off again leaving
 * the address exactly as the thread was made at — a re-encoded query would
 * not match it, and the pin would stay dimmed.
 */
describe('the address a thread is gone to', () => {
  it.each([
    ['/case/harborlight/?top=5&o=ss%2Cwb&cw-goto=t-1', '/case/harborlight/?top=5&o=ss%2Cwb'],
    ['/case/harborlight/?cw-goto=t-1', '/case/harborlight/'],
    ['/case/harborlight/?cw-goto=t-1&o=a%20b', '/case/harborlight/?o=a%20b'],
    ['/case/?all=1&cw-goto=t-1&cw-frame=1#tides', '/case/?all=1&cw-frame=1#tides'],
    ['/case/?cw-goto=t-1#tides', '/case/#tides'],
  ])('takes the thread off %s', (url, rest) => {
    expect(takeGoTo(url)).toEqual({ id: 't-1', rest });
  });

  it('leaves an address with no thread on it alone', () => {
    expect(takeGoTo('/case/harborlight/?o=ss')).toBeNull();
  });
});

describe('going to a thread', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('loads a path on this origin', () => {
    history.replaceState(null, '', '/case/harborlight/');
    goTo('/case/harborlight/?o=ss#tides', 't-1');
    expect(location.pathname + location.search + location.hash).toBe(
      '/case/harborlight/?o=ss&cw-goto=t-1#tides',
    );
  });

  it.each([
    'javascript:alert(1)',
    '//saltmarsh.example/x',
    '/\\saltmarsh.example/x',
    'https://saltmarsh.example/',
  ])('loads nothing for %s, an address a commenter could aim elsewhere', (url) => {
    history.replaceState(null, '', '/case/harborlight/');
    goTo(url, 't-1');
    expect(location.href).toBe(`${location.origin}/case/harborlight/`);
  });
});
