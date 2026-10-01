/**
 * A well-sourced research note, scrolled top to bottom, measured: where every
 * margin note is painted, and whether the sentence it belongs to is on screen.
 *
 * It mounts the REAL surface — a real editor, a real `mountReviewChrome`, and
 * `mountDocMargin`, which wires the footnote notes into the balloon column
 * exactly as the review page does — and then scrolls the pane the way a reader
 * does. Nothing here reads or asserts on source; it reports measured
 * rectangles.
 *
 * Fixture names are invented (Harborlight, Riverbend, Saltmarsh).
 */
import { type User, prose } from '@claude-workspaces/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { balloonMarginVisible } from '../src/card-placement.ts';
import { mountDocMargin } from '../src/doc/doc-margin.ts';
import { createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';

/** See `ScrollReading.vanished`. */
const ROOM_PX = 60;

/** One margin note as painted, against the sentence it belongs to. */
interface NoteReading {
  n: string;
  /** Is any of the note painted inside the pane's visible box? */
  noteOnScreen: boolean;
  /** Is the note's own `^[…]` run inside the pane's visible box? */
  anchorOnScreen: boolean;
  top: number;
  bottom: number;
  anchorTop: number;
}

export interface ScrollReading {
  scrollTop: number;
  /** The pane's visible box, in viewport px. */
  paneTop: number;
  paneBottom: number;
  /** Notes whose anchor is on screen and whose card is not. */
  missing: string[];
  /** …of those, the ones whose line has `ROOM_PX` of pane below it — the
   *  vanishing. A note in a stack is pushed down by the notes above it, so
   *  one whose line is the last sliver of the pane may sit just under it. */
  vanished: string[];
  /** Pairs of on-screen notes whose boxes intersect — the bunching. */
  overlaps: Array<[string, string, number]>;
  /** Notes beside an on-screen anchor — the control for both counts. */
  beside: number;
}

export interface FootnoteProbe {
  marginVisible: boolean;
  /** Notes the doc holds, and margin cards found for them. */
  notes: number;
  cards: number;
  /** Runs whose superscript number is drawn — the phone's half of the
   *  feature, and none where the margin carries the notes. */
  superscripts: number;
  scrollHeight: number;
  clientHeight: number;
  /** Read every few frames during one continuous gesture, top to foot and
   *  back, a few px a frame — the column's debounce never fires mid-gesture,
   *  which is what a flick on an iPad is. */
  scrolling: ScrollReading[];
  /** After the column has had its debounce at each step. */
  settled: ScrollReading[];
}

/** A source note in the shape the research notes carry: a link, a page range
 *  and a backticked provenance tag. Long on purpose — three or four lines in
 *  the margin column, which is what a real citation runs to. */
function note(i: number): string {
  const place = ['Harborlight', 'Riverbend', 'Saltmarsh'][i % 3] as string;
  return (
    `^[${place} Safe Routes, [2024-25 Annual Report](https://www.example.org/${place.toLowerCase()}.pdf), ` +
    `pp. ${40 + i}-${41 + i}. \`[primary — read 2026-09-30]\`]`
  );
}

const FILL =
  'The crossing guards counted walkers at each school gate twice a term and the totals were ' +
  'compared against the enrolment figures the district publishes each autumn';

/** About twenty paragraphs, a note on most, a few short ones close together,
 *  three tables and three bullet lists. */
export function fixtureMarkdown(): string {
  const out: string[] = ['# Harborlight walking audit'];
  let n = 0;
  for (let i = 0; i < 20; i++) {
    // Short paragraphs in a run: their anchors are a line apart, so their
    // notes cannot all sit beside them and must stack.
    const short = i >= 5 && i <= 8;
    const body = short ? `Gate ${i} counted ${30 + i} walkers.` : `Paragraph ${i}: ${FILL}.`;
    out.push(i % 6 === 3 ? body : `${body}${note(n++)}`);
    if (i === 4 || i === 11 || i === 17) {
      out.push(
        [
          '| School | Walkers | Share |',
          '| --- | --- | --- |',
          '| Harborlight | 120 | 31% |',
          '| Riverbend | 96 | 24% |',
          '| Saltmarsh | 88 | 22% |',
        ].join('\n'),
      );
      out.push(
        [
          `- Alice counted the north gate.${note(n++)}`,
          `- Bob counted the south gate.${note(n++)}`,
          '- Nobody counted the east gate.',
        ].join('\n'),
      );
    }
  }
  return out.join('\n\n');
}

const USER: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function read(editorEl: HTMLElement, proseEl: HTMLElement): ScrollReading {
  const pane = editorEl.getBoundingClientRect();
  const top = pane.top;
  const bottom = pane.top + editorEl.clientHeight;
  const per: NoteReading[] = [];
  const seen = new Set<string>();
  for (const a of proseEl.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]')) {
    const n = a.dataset.cwFn ?? '';
    if (seen.has(n)) continue;
    seen.add(n);
    const ar = a.getBoundingClientRect();
    // The margin card is the `.cw-fn-note` the column placed for this number.
    const card = [...document.querySelectorAll<HTMLElement>('.markup-margin .cw-fn-note')].find(
      (el) => el.dataset.fnProbe === n,
    );
    const cr = card?.getBoundingClientRect();
    const painted =
      card !== undefined &&
      cr !== undefined &&
      getComputedStyle(card).display !== 'none' &&
      cr.height > 0 &&
      cr.bottom > top &&
      cr.top < bottom;
    per.push({
      n,
      noteOnScreen: painted,
      anchorOnScreen: ar.bottom > top && ar.top < bottom,
      top: cr?.top ?? Number.NaN,
      bottom: cr?.bottom ?? Number.NaN,
      anchorTop: ar.top,
    });
  }
  const shown = per.filter((p) => p.noteOnScreen);
  const overlaps: Array<[string, string, number]> = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i] as NoteReading;
      const b = shown[j] as NoteReading;
      const o = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (o > 0.5) overlaps.push([a.n, b.n, Math.round(o)]);
    }
  }
  return {
    scrollTop: editorEl.scrollTop,
    paneTop: top,
    paneBottom: bottom,
    missing: per.filter((p) => p.anchorOnScreen && !p.noteOnScreen).map((p) => p.n),
    vanished: per
      .filter((p) => p.anchorOnScreen && p.anchorTop < bottom - ROOM_PX && !p.noteOnScreen)
      .map((p) => p.n),
    overlaps,
    beside: per.filter((p) => p.anchorOnScreen && p.noteOnScreen).length,
  };
}

async function probe(): Promise<string> {
  const editorEl = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(fixtureMarkdown()));
  const editor = createEditor({ parent: editorEl, ydoc, awareness: new Awareness(ydoc) });
  const scope = new MountScope();
  const chrome = mountReviewChrome({
    docId: 'd1',
    user: USER,
    ydoc,
    surface: editor,
    whenSynced: (cb) => cb(),
    canWrite: true,
    scope,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => editor.getSelectionRel(),
  });
  mountDocMargin({ docId: 'd1', ydoc, scope, editor, editorMount: editorEl, chrome });
  await frame();
  await sleep(300);
  await frame();

  // Tag each card with its number so the reading can pair it with its run.
  // The column owns the elements and keeps them across relayouts, so the tag
  // set once survives every step below.
  const proseEl = editor.editor.view.dom;
  const cards = [...document.querySelectorAll<HTMLElement>('.markup-margin .cw-fn-note')];
  const runs = [...proseEl.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]')];
  const notes = new Set(runs.map((r) => r.dataset.cwFn));
  // Cards are appended in note order, one per number.
  [...notes].forEach((n, i) => {
    const c = cards[i];
    if (c && n) c.dataset.fnProbe = n;
  });

  const max = editorEl.scrollHeight - editorEl.clientHeight;
  const hold = (window as { footnoteHold?: string }).footnoteHold;
  if (hold === 'gesture') {
    // Leave the pane MID-GESTURE for the screenshot: still moving, a pixel a
    // frame, so the column's debounce has not fired when the capture lands.
    editorEl.scrollTop = 0;
    await sleep(250);
    await frame();
    const to = Math.round(max * 0.3);
    while (editorEl.scrollTop < to) {
      editorEl.scrollTop += 9;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    // …and keep it moving after this returns, so the capture lands mid-flick.
    let tick = 0;
    const keep = setInterval(() => {
      editorEl.scrollTop += 3;
      if (++tick > 200) clearInterval(keep);
    }, 16);
    return JSON.stringify({ hold: read(editorEl, proseEl) });
  }
  const scrolling: ScrollReading[] = [];
  const settled: ScrollReading[] = [];
  // One gesture, down and back, 12px a frame, read every sixth frame.
  const path: number[] = [];
  for (let y = 0; y <= max; y += 12) path.push(y);
  path.push(max);
  for (let y = max; y >= 0; y -= 12) path.push(y);
  for (const [i, y] of path.entries()) {
    editorEl.scrollTop = y;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (i % 6 === 0) scrolling.push(read(editorEl, proseEl));
  }
  // Then at rest: step through the doc, letting the column settle at each stop.
  const step = Math.max(80, Math.round(editorEl.clientHeight / 4));
  const stops: number[] = [];
  for (let y = 0; y < max; y += step) stops.push(y);
  stops.push(max);
  for (const y of [...stops, ...stops.slice(0, -1).reverse()]) {
    editorEl.scrollTop = y;
    await sleep(250);
    await frame();
    settled.push(read(editorEl, proseEl));
  }
  // Leave the pane part-way down, settled, for the screenshot.
  editorEl.scrollTop = Math.round(max * 0.4);
  await frame();
  await sleep(250);
  await frame();

  const out: FootnoteProbe = {
    marginVisible: balloonMarginVisible(),
    notes: notes.size,
    cards: cards.length,
    superscripts: runs.filter((r) => getComputedStyle(r, '::after').display !== 'none').length,
    scrollHeight: editorEl.scrollHeight,
    clientHeight: editorEl.clientHeight,
    scrolling,
    settled,
  };
  return JSON.stringify(out);
}

declare global {
  interface Window {
    footnoteMarginProbe: () => Promise<string>;
  }
}
window.footnoteMarginProbe = probe;
