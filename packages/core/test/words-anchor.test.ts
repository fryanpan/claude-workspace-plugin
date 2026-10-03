/**
 * @vitest-environment happy-dom
 *
 * An anchor an agent makes from words alone. It cannot see the page, so it
 * has no tag, no classes and no path to give: only the text a reader sees.
 * The page finds the smallest element that says it, once the resolver is
 * installed on `window.cwWords` (the widget's edit chunk does that).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnchor, createWordsAnchor, resolve, resolveWords } from '../src/anchor/element.ts';

describe('a words anchor', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main><section><h1>Harborlight Projects</h1>' +
      '<p class="lede">Riverbend <b>opens</b>   at nine.</p></section>' +
      '<p>Saltmarsh opens at ten.</p></main>' +
      '<div data-feedback-widget><p>Riverbend opens at nine.</p></div>';
    window.cwWords = resolveWords;
  });
  afterEach(() => {
    window.cwWords = undefined;
  });

  it('resolves nothing until the resolver is installed, and leaves a person anchor alone', () => {
    window.cwWords = undefined;
    expect(resolve(createWordsAnchor('Riverbend opens at nine'), { root: document }).ok).toBe(
      false,
    );
    const person = createAnchor(document.querySelector('h1') as HTMLElement);
    const res = resolve(person, { root: document });
    expect(res.ok && res.element.tagName).toBe('H1');
  });

  it('has the shape of a person anchor, with its words as the snippet', () => {
    const a = createWordsAnchor('Riverbend opens', { url: '/events' });
    expect(a.kind).toBe('element');
    expect(a.fingerprint.text).toBe('Riverbend opens');
    expect(a.snippet.text).toBe('Riverbend opens');
    expect(a.context).toEqual({ url: '/events' });
  });

  it('resolves to the smallest element whose words hold the text, across inline markup', () => {
    const res = resolve(createWordsAnchor('Riverbend opens at nine'), { root: document });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.element.className).toBe('lede');
  });

  it('finds a heading by part of its words', () => {
    const res = resolve(createWordsAnchor('Harborlight'), { root: document });
    expect(res.ok && res.element.tagName).toBe('H1');
  });

  it('is not found when no element on the page says it', () => {
    const res = resolve(createWordsAnchor('Closed on Sundays'), { root: document });
    expect(res.ok).toBe(false);
  });

  it('never resolves into the widget itself', () => {
    document.querySelector('.lede')?.remove();
    const res = resolve(createWordsAnchor('Riverbend opens at nine'), { root: document });
    expect(res.ok).toBe(false);
  });
});
