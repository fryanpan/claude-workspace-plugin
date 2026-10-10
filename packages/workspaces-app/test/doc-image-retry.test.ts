import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  RETRY_FAST_FOR_MS,
  RETRY_FAST_MS,
  RETRY_SLOW_MS,
  type RetryClock,
  retryFailedDocImages,
} from '../src/doc-image-retry.ts';
import { docAssetsBase, fromDisplaySrc } from '../src/doc-image-src.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * A doc opened before its image file exists shows the image once the file
 * lands, without a reload: a failed doc-asset `<img>` is asked for again.
 */
const BASE = docAssetsBase('harborlight', 'ws-1');

/** A clock the test advances by hand. */
function manualClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: RetryClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { clock, advance, pendingTimers: () => timers.size };
}

const roots: HTMLElement[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const r of roots.splice(0)) r.remove();
});

function setup(src: string, visible: () => boolean = () => true) {
  const root = document.createElement('div');
  const img = document.createElement('img');
  img.setAttribute('src', src);
  root.appendChild(img);
  document.body.appendChild(root);
  roots.push(root);
  const c = manualClock();
  stops.push(retryFailedDocImages(root, BASE, c.clock, visible));
  return { root, img, ...c };
}

const fail = (img: HTMLImageElement) => img.dispatchEvent(new Event('error'));
const load = (img: HTMLImageElement) => img.dispatchEvent(new Event('load'));

describe('a failed doc image is asked for again', () => {
  it('retries each second until it loads, then stops', () => {
    const { img, advance, pendingTimers } = setup(`${BASE}chart.png`);
    fail(img);
    advance(RETRY_FAST_MS);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png?r=1`);
    fail(img);
    advance(RETRY_FAST_MS);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png?r=2`);

    load(img);
    expect(pendingTimers()).toBe(0);
    advance(RETRY_SLOW_MS * 10);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png?r=2`);
  });

  it('slows to every ten seconds after a minute of failing', () => {
    const { img, advance } = setup(`${BASE}chart.png`);
    let attempts = 0;
    fail(img);
    while (attempts < RETRY_FAST_FOR_MS / RETRY_FAST_MS) {
      advance(RETRY_FAST_MS);
      attempts += 1;
      fail(img);
    }
    const before = img.getAttribute('src');
    advance(RETRY_SLOW_MS - 1);
    expect(img.getAttribute('src')).toBe(before);
    advance(1);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png?r=${attempts + 1}`);
  });

  it('asks nothing while the page is hidden', () => {
    let visible = false;
    const { img, advance } = setup(`${BASE}chart.png`, () => visible);
    fail(img);
    advance(RETRY_FAST_MS * 5);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png`);
    visible = true;
    advance(RETRY_FAST_MS);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png?r=1`);
  });

  it('stops once the image leaves the page', () => {
    const { root, img, advance, pendingTimers } = setup(`${BASE}chart.png`);
    fail(img);
    root.removeChild(img);
    advance(RETRY_FAST_MS);
    expect(img.getAttribute('src')).toBe(`${BASE}chart.png`);
    expect(pendingTimers()).toBe(0);
  });

  it('never retries an image from outside the doc’s folder', () => {
    const { img, advance, pendingTimers } = setup('https://example.com/a.png');
    fail(img);
    expect(pendingTimers()).toBe(0);
    advance(RETRY_SLOW_MS);
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('a retried address pastes back as the path as written', () => {
    expect(fromDisplaySrc(`${BASE}img/a%20b.png?r=7`, BASE)).toBe('img/a b.png');
  });
});

describe('in the editor', () => {
  const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight');
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const o of open.splice(0)) {
      o.handle.destroy();
      o.parent.remove();
    }
    vi.useRealTimers();
  });

  it('retries a missing image and keeps the stored path', () => {
    const ydoc = new Y.Doc();
    const fragment = prose.getProseFragment(ydoc);
    fragment.push(prose.parseMarkdownBlocks('Riverbend\n\n![caption](img/chart.png)\n'));
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = createEditor({
      parent,
      ydoc,
      awareness: new Awareness(ydoc),
      imageDocId: 'harborlight',
    });
    open.push({ handle, parent });

    const img = parent.querySelector('img');
    if (!img) throw new Error('no image rendered');
    const shown = '/workspaces/ws-1/docs/harborlight/assets/img/chart.png';
    expect(img.getAttribute('src')).toBe(shown);
    fail(img);
    vi.advanceTimersByTime(RETRY_FAST_MS);
    expect(img.getAttribute('src')).toBe(`${shown}?r=1`);
    load(img);
    vi.advanceTimersByTime(RETRY_SLOW_MS * 10);
    expect(img.getAttribute('src')).toBe(`${shown}?r=1`);

    handle.editor.commands.insertContentAt(1, 'Saltmarsh ');
    const md = prose.serializeFragmentToMarkdown(fragment);
    expect(md).toContain('![caption](img/chart.png)');
    expect(md).not.toContain('?r=');
  });
});
