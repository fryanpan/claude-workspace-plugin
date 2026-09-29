/**
 * The review doc, as the list of passages a person could be talking about.
 *
 * The widget describes a page element by element (`collectTargets`); a
 * document is read passage by passage, so the catalog here is its blocks —
 * headings, paragraphs, list items, table rows, quotes and code — and the
 * words a reader has selected while talking. The server never sees the DOM:
 * an index is the only name that crosses the socket, and this module is where
 * it turns back into a passage and then into a comment anchor.
 *
 * A block names the heading of its section as its parent (`in e3`), so "the
 * Saltmarsh row in the risks table" can be told from another row saying
 * Saltmarsh.
 */
import {
  type Anchor,
  MAX_VOICE_TARGETS,
  VOICE_TARGET_TEXT,
  type VoiceTarget,
} from '@claude-workspaces/core';
import type { EditorHandle } from '../editor.ts';
import { type ChromeSelection, anchorBody } from './anchor-body.ts';

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,tr,blockquote,pre';
/** A paragraph inside one of these is spoken of as the container. */
const CONTAINERS = 'li,td,th,blockquote';
/** In-flow chrome inside the prose: comment cards, chips. Not the doc. */
const CHROME = '.cw-inline-card,.ProseMirror-widget';

const squash = (s: string | null | undefined, max = VOICE_TARGET_TEXT): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The first few words of a passage's first clause: "Week two adds reminders". */
function snip(text: string, n = 4): string {
  const clause = text.split(/[.;:](\s|$)/)[0] ?? text;
  const w = squash(clause, 400).split(' ');
  return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}…`;
}

/**
 * The anchor as the thread routes take it: the composer's own body, whose
 * positions are number arrays because that is what survives JSON. The
 * session's type says `Anchor` because the widget's element anchors are one;
 * only the wire sees this value.
 */
const wire = (sel: ChromeSelection): Anchor => anchorBody(sel) as unknown as Anchor;

interface Pointed {
  sel: ChromeSelection;
  block: number | null;
}

export interface DocVoiceTargets {
  /** Every passage now on the page, plus the selections pointed at. */
  catalog(): VoiceTarget[];
  /** The block a target is (or sits in), while it is still on the page. */
  element(target: number | null): HTMLElement | null;
  /** Where a comment on `target` is anchored; `null` is the doc's title. */
  anchorFor(target: number | null): Anchor;
  /** What the live card calls it: "Rollout · Week two adds…", "“by Friday”". */
  name(target: number | null): string;
  /** The passage a tap landed in, or null outside the prose. */
  blockAt(node: EventTarget | null): number | null;
  /** Remember a selection as a target of its own; answers its index. */
  point(sel: ChromeSelection, inside: Node): number;
  /** The selection a pointed target stands for; undefined for a passage. */
  selection(target: number): ChromeSelection | undefined;
}

export function docVoiceTargets(editor: EditorHandle): DocVoiceTargets {
  const root = (): HTMLElement => editor.editor.view.dom as HTMLElement;
  // One numbering for the life of the mount: a passage keeps its index while
  // the doc changes under the speaker, which is what a comment the server is
  // still growing relies on.
  const ids = new Map<Element, number>();
  const byIndex = new Map<number, HTMLElement>();
  const pointed = new Map<number, Pointed>();
  const section = new Map<number, string>();
  let next = 0;
  const indexOf = (el: Element): number => {
    let i = ids.get(el);
    if (i === undefined) {
      i = next++;
      ids.set(el, i);
    }
    return i;
  };

  const blocks = (): HTMLElement[] =>
    Array.from(root().querySelectorAll<HTMLElement>(BLOCKS)).filter((el) => {
      if (el.closest(CHROME)) return false;
      if (el.tagName === 'P' && el.parentElement?.closest(CONTAINERS)) return false;
      return squash(el.textContent) !== '';
    });

  function catalog(): VoiceTarget[] {
    const out: VoiceTarget[] = [];
    byIndex.clear();
    section.clear();
    let heading: { i: number; text: string } | null = null;
    for (const el of blocks()) {
      if (out.length >= MAX_VOICE_TARGETS) break;
      const i = indexOf(el);
      byIndex.set(i, el);
      const tag = el.tagName.toLowerCase();
      const text = squash(el.textContent);
      let parent: number | undefined;
      for (let p = el.parentElement; p && p !== root(); p = p.parentElement) {
        const at = ids.get(p);
        if (at !== undefined && byIndex.get(at) === p) {
          parent = at;
          break;
        }
      }
      if (/^h[1-6]$/.test(tag)) heading = { i, text };
      else {
        if (parent === undefined && heading) parent = heading.i;
        if (heading) section.set(i, heading.text);
      }
      out.push({ i, tag, text, ...(parent !== undefined ? { parent } : {}) });
    }
    for (const [i, p] of pointed) {
      out.push({
        i,
        tag: 'mark',
        text: squash(p.sel.snippet),
        ...(p.block !== null ? { parent: p.block } : {}),
      });
    }
    return out;
  }

  function element(target: number | null): HTMLElement | null {
    if (target === null) return null;
    const p = pointed.get(target);
    const el = byIndex.get(p ? (p.block ?? -1) : target);
    return el?.isConnected ? el : null;
  }

  function anchorFor(target: number | null): Anchor {
    const p = target === null ? undefined : pointed.get(target);
    if (p) return wire(p.sel);
    // The doc as a whole lands on its first passage — the title, usually —
    // so the comment still stands in the margin rather than in no place.
    const el = element(target) ?? blocks()[0] ?? null;
    if (!el) return { kind: 'subject' };
    const view = editor.editor.view;
    try {
      const from = view.posAtDOM(el, 0);
      const to = view.posAtDOM(el, el.childNodes.length);
      const rel = to > from ? editor.rangeRel(from, to) : null;
      if (rel) return wire(rel);
    } catch {
      // A block ProseMirror has not rendered answers no position.
    }
    return { kind: 'subject' };
  }

  function name(target: number | null): string {
    const p = target === null ? undefined : pointed.get(target);
    if (p) {
      const q = squash(p.sel.snippet, 400);
      return `“${q.length > 30 ? `${q.slice(0, 29)}…` : q}”`;
    }
    const el = element(target);
    if (!el) return 'This doc';
    const cells = el.tagName === 'TR' ? el.querySelector('td,th') : null;
    const words = snip((cells ?? el).textContent ?? '');
    const sec = target === null ? undefined : section.get(target);
    return sec ? `${snip(sec, 3)} · ${words}` : words;
  }

  function blockAt(node: EventTarget | null): number | null {
    let el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    if (!el || !root().contains(el) || el.closest(CHROME)) return null;
    for (; el && el !== root(); el = el.parentElement) {
      const i = ids.get(el);
      if (i !== undefined && byIndex.get(i) === el) return i;
    }
    return null;
  }

  function point(sel: ChromeSelection, inside: Node): number {
    const i = next++;
    pointed.set(i, { sel, block: blockAt(inside) });
    return i;
  }

  const selection = (target: number): ChromeSelection | undefined => pointed.get(target)?.sel;

  return { catalog, element, anchorFor, name, blockAt, point, selection };
}
