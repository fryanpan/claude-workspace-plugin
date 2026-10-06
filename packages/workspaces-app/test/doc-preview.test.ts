// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { getProseFragment } from '@claude-workspaces/core/prose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { applyPlacement, onPlacementChange } from '../src/card-placement.ts';
import { createReloadScheduler, previewFrameSrc } from '../src/doc/doc-preview-model.ts';
import { mountDocPreview } from '../src/doc/doc-preview.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The doc page's app preview (doc/doc-preview.ts): the frame loads only a page
 * under this board's app doors, and it reloads after the prose changes —
 * not after a comment, and not when the app already reloaded itself.
 */

const WS = 'harborlight';
const BASE = 'https://board.example/workspaces/harborlight/review/d-1';

describe('previewFrameSrc', () => {
  it("loads a page under one of this board's app doors, as the embed frame does", () => {
    expect(previewFrameSrc('/workspaces/harborlight/apps/site/walks/', WS, BASE)).toBe(
      '/workspaces/harborlight/apps/site/walks/?cw-frame=1&cw-embed=1',
    );
  });

  it('refuses anything else', () => {
    for (const raw of [
      '',
      '/workspaces/riverbend/apps/site/',
      '/workspaces/harborlight/apps/site/../../../api/docs',
      '/workspaces/harborlight/apps/',
      '/workspaces/harborlight/apps/site',
      'https://elsewhere.example/workspaces/harborlight/apps/site/',
      '//elsewhere.example/workspaces/harborlight/apps/site/',
      'javascript:alert(1)',
    ]) {
      expect(previewFrameSrc(raw, WS, BASE), raw).toBeNull();
    }
  });
});

describe('createReloadScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reloads once, a delay after the last of several edits', () => {
    const reload = vi.fn();
    const s = createReloadScheduler({ delayMs: 2000, reload });
    s.edited();
    vi.advanceTimersByTime(1500);
    s.edited();
    vi.advanceTimersByTime(1999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('skips the reload when the page loaded by itself inside the window', () => {
    const reload = vi.fn();
    const s = createReloadScheduler({ delayMs: 2000, reload });
    s.edited();
    vi.advanceTimersByTime(900);
    s.frameLoaded();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('mountDocPreview', () => {
  let scope: MountScope;
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    document.body.innerHTML =
      '<header id="topbar"><div class="toolbar"></div></header><main id="main"><section id="editor-pane"></section></main>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    scope = new MountScope();
  });
  afterEach(() => {
    scope.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function openOn(path: string, ydoc: Y.Doc) {
    const p = mountDocPreview({ docId: 'd-1', ydoc, scope, workspaceId: WS, reloadMs: 2000 });
    if (!p) throw new Error('not mounted');
    const input = p.pane.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('no input');
    p.toggle.click();
    input.value = path;
    p.pane.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    return p;
  }

  it('shows a sandboxed frame of the chosen page and remembers it for this doc', () => {
    const p = openOn('/workspaces/harborlight/apps/site/', new Y.Doc());
    expect(document.body.classList.contains('preview-open')).toBe(true);
    expect(p.toggle.getAttribute('aria-pressed')).toBe('true');
    expect(p.frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(p.frame.getAttribute('src')).toBe(
      '/workspaces/harborlight/apps/site/?cw-frame=1&cw-embed=1',
    );
    expect(JSON.parse(localStorage.getItem('cw:doc-preview:d-1') ?? '{}')).toEqual({
      path: '/workspaces/harborlight/apps/site/',
      open: true,
    });
  });

  it('reloads the frame after a prose edit, and not after a comment', () => {
    const ydoc = new Y.Doc();
    const p = openOn('/workspaces/harborlight/apps/site/', ydoc);
    const sets: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    Object.defineProperty(p.frame, 'src', {
      configurable: true,
      get: () => desc?.get?.call(p.frame),
      set: (v: string) => {
        sets.push(v);
        desc?.set?.call(p.frame, v);
      },
    });

    ydoc.getMap('threads').set('t-1', new Y.Map());
    vi.advanceTimersByTime(5000);
    expect(sets).toEqual([]);

    getProseFragment(ydoc).push([new Y.XmlElement('paragraph')]);
    vi.advanceTimersByTime(1999);
    expect(sets).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sets).toEqual(['/workspaces/harborlight/apps/site/?cw-frame=1&cw-embed=1']);
  });

  it('reopens on the same page after the doc remounts, and removes itself on teardown', () => {
    openOn('/workspaces/harborlight/apps/site/', new Y.Doc());
    scope.dispose();
    expect(document.getElementById('preview-pane')).toBeNull();
    expect(document.body.classList.contains('preview-open')).toBe(false);
    scope = new MountScope();
    const again = mountDocPreview({ docId: 'd-1', ydoc: new Y.Doc(), scope, workspaceId: WS });
    expect(document.body.classList.contains('preview-open')).toBe(true);
    expect(again?.frame.getAttribute('src')).toBe(
      '/workspaces/harborlight/apps/site/?cw-frame=1&cw-embed=1',
    );
  });

  it('moves the comment cards into the flow while it holds half the window', () => {
    // A window wide enough for the balloon column.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    applyPlacement();
    onPlacementChange(
      (t, type, fn) => scope.listen(t, type, fn),
      () => applyPlacement(),
    );
    expect(document.body.dataset.cards).toBe('balloon');
    const p = mountDocPreview({ docId: 'd-1', ydoc: new Y.Doc(), scope, workspaceId: WS });
    p?.toggle.click();
    expect(document.body.dataset.cards).toBe('inline');
    p?.toggle.click();
    expect(document.body.dataset.cards).toBe('balloon');
  });

  it('mounts nothing off a board', () => {
    expect(mountDocPreview({ docId: 'd-1', ydoc: new Y.Doc(), scope, workspaceId: null })).toBe(
      null,
    );
  });
});
