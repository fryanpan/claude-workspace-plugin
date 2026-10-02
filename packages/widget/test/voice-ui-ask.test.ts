import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { box, comment, heights, rowAt, screen, setup } from './voice-ui-harness.ts';

/**
 * The clarifying question on the widget's voice column: just under the live
 * card, where the reader is looking, and over the page rather than in the
 * column, so no card moves when it appears or goes.
 */

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const ASK = {
  key: 'v3',
  question: 'Which Save button?',
  choices: ['Save in the header', 'Save in the footer'],
  about: 'anchor' as const,
};

function scene() {
  screen(1180, 820);
  heights();
  const t = setup();
  t.elements.set(3, rowAt(100, 140));
  t.elements.set(4, rowAt(300, 340));
  t.add(comment({ key: 'v1', target: 4, final: true }));
  t.add(comment({ key: 'v3', target: 3, text: 'This Save button is too small.' }));
  // The test DOM lays nothing out: the live card's box is where it was placed.
  vi.spyOn(t.view.live, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({
      x: Number.parseFloat(t.view.live.style.left),
      y: Number.parseFloat(t.view.live.style.top),
      width: 280,
      height: 150,
    }),
  );
  t.view.place();
  return t;
}

describe('the question on the voice column', () => {
  it('stands just under the live card, and nothing beside it moves', () => {
    const t = scene();
    const before = { live: box(t.view.live), card: box(t.card('v1')) };
    expect(t.view.ask.hidden, 'CONTROL: no question, nothing shown').toBe(true);

    t.session.ask = ASK;
    t.view.render();
    expect(t.view.ask.hidden).toBe(false);
    expect(t.view.ask.querySelector('.vq')?.textContent).toBe('Which Save button?');
    expect([...t.view.ask.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Save in the header',
      'Save in the footer',
      'Keep as is',
    ]);
    expect(t.view.ask.style.top).toBe(`${before.live.bottom + 6}px`);
    expect(t.view.ask.style.left).toBe(t.view.live.style.left);
    expect(box(t.view.live), 'the live card stays put').toEqual(before.live);
    expect(box(t.card('v1')), 'the card under it stays put').toEqual(before.card);

    t.session.ask = null;
    t.view.render();
    expect(t.view.ask.hidden).toBe(true);
    expect(box(t.card('v1')), 'nor moves when it goes').toEqual(before.card);
  });

  it('is over the cards it lands on, which share its layer', () => {
    const t = scene();
    t.session.ask = ASK;
    t.view.render();
    const root = t.view.ask.getRootNode() as ShadowRoot;
    expect(root.lastElementChild, 'a card made before it').toBe(t.view.ask);
    t.add(comment({ key: 'v5', target: 4, final: true }));
    t.view.render();
    expect(root.lastElementChild, 'and one made after it').toBe(t.view.ask);
  });

  it('answers with the choice tapped, or keeps the note as it is', () => {
    const t = scene();
    t.session.ask = ASK;
    t.view.render();
    (t.view.ask.querySelector('[data-i="1"]') as HTMLElement).click();
    (t.view.ask.querySelector('.vkeep') as HTMLElement).click();
    expect(t.session.answer.mock.calls).toEqual([[1], [null]]);
  });

  it('is not shown while Move is choosing a place, or once recording stops', () => {
    const t = scene();
    t.session.ask = ASK;
    t.view.picking = 'v3';
    t.view.render();
    expect(t.view.ask.hidden).toBe(true);
    t.view.picking = null;
    t.session.state = 'idle';
    t.view.render();
    expect(t.view.ask.hidden).toBe(true);
  });
});
