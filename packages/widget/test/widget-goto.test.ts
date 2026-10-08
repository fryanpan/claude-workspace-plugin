import { describe, expect, it } from 'vitest';
import { takeGoTo } from '../src/widget-goto.ts';

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
