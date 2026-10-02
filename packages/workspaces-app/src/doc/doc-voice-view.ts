/**
 * What voice comments look like on the review doc — the design approved on
 * 29 September: the widget's mic, live card and outline, placed for a
 * document.
 *
 * - The mic is a round button at the bottom right, apart from Record Audio.
 *   While recording it is a still red Stop button: nothing pulses or blinks.
 * - The live card shows the note being said and, grey under it, the words
 *   since the last pause. It floats above the mic until the note has a
 *   passage, then stands in the comment margin level with it (on a phone,
 *   docked above the mic). A dashed outline marks the passage.
 * - After five seconds with nothing heard it says so, in the card.
 * - A question about the note being said stands just under the live card
 *   (just over it when the mic is below), over the page, so nothing beside
 *   it moves: the question, its choices, and Keep as is.
 * - A finished note is an ordinary comment: the doc's own margin card draws
 *   it (`voice-note-foot.ts` adds its clip, raw words and Undo).
 *
 * The card's head keeps its height and the Move button its slot in every
 * state, so nothing in the card jumps as the words arrive.
 */
import { balloonMarginVisible } from '../card-placement.ts';
import { MIC_ICON } from '../icons.ts';
import { composerSlot } from './composer-slot.ts';

export const IDLE_TIP = 'Talk to comment on this doc';
export const STOP_TIP = 'Stop recording';
export const NOTHING_HEARD =
  'Nothing heard yet. Check that the browser is using the microphone you are speaking into.';

/** One frame of the live card, as the controller sees the session. */
export interface LiveFrame {
  on: boolean;
  where: string;
  /** Italic grey: no passage yet, or a state word ("Starting…"). */
  seeking: boolean;
  picking: boolean;
  /** The note's tidied words, or the nothing-heard hint. */
  text: string;
  hint: boolean;
  /** Words since the last pause. */
  pending: string;
  canMove: boolean;
  /** The passage the note is about, when it is on the page. */
  passage: HTMLElement | null;
  /** Something to tell the person beside the mic, or null. */
  notice: string | null;
  /** The question asked about the note, with its choices; null when none. */
  ask: { question: string; choices: string[] } | null;
}

export class DocVoiceView {
  readonly mic: HTMLButtonElement;
  readonly readout: HTMLDivElement;
  readonly live: HTMLDivElement;
  readonly outline: HTMLDivElement;
  readonly move: HTMLButtonElement;
  /** The question; a tapped choice's `data-i` is its index, Keep has none. */
  readonly ask: HTMLDivElement;
  private frame: LiveFrame | null = null;

  constructor(private readonly editorMount: HTMLElement) {
    this.mic = document.createElement('button');
    this.mic.type = 'button';
    this.mic.className = 'doc-voice-mic';
    this.mic.innerHTML = `${MIC_ICON}<span class="doc-voice-stop"></span>`;
    this.readout = document.createElement('div');
    this.readout.className = 'doc-voice-readout';
    this.readout.hidden = true;
    this.readout.setAttribute('aria-live', 'polite');
    this.readout.addEventListener('click', () => {
      this.readout.hidden = true;
    });
    this.live = document.createElement('div');
    this.live.className = 'doc-voice-live';
    this.live.hidden = true;
    this.live.setAttribute('aria-live', 'polite');
    this.live.innerHTML =
      '<div class="doc-voice-head"><span class="doc-voice-dot"></span>' +
      '<span class="doc-voice-where"></span>' +
      '<button class="doc-voice-move" type="button">Move</button></div>' +
      '<div class="doc-voice-text"></div><div class="doc-voice-pending"><span></span></div>';
    this.move = this.live.querySelector('.doc-voice-move') as HTMLButtonElement;
    this.outline = document.createElement('div');
    this.outline.className = 'doc-voice-outline';
    this.outline.hidden = true;
    this.ask = document.createElement('div');
    this.ask.className = 'doc-voice-ask';
    this.ask.hidden = true;
    this.ask.setAttribute('role', 'group');
    document.body.append(this.outline, this.live, this.ask, this.mic, this.readout);
  }

  draw(f: LiveFrame): void {
    this.frame = f;
    document.body.classList.toggle('doc-voice-on', f.on);
    document.body.classList.toggle('doc-voice-picking', f.picking);
    this.mic.classList.toggle('on', f.on);
    this.mic.setAttribute('aria-pressed', String(f.on));
    const tip = f.on ? STOP_TIP : IDLE_TIP;
    this.mic.title = tip;
    this.mic.setAttribute('aria-label', tip);
    this.readout.textContent = f.notice ?? '';
    this.readout.hidden = !f.notice;
    this.live.hidden = !f.on;
    const where = this.live.querySelector('.doc-voice-where') as HTMLElement;
    where.textContent = f.where;
    where.classList.toggle('seeking', f.seeking);
    const text = this.live.querySelector('.doc-voice-text') as HTMLElement;
    text.textContent = f.text;
    text.classList.toggle('hint', f.hint);
    (this.live.querySelector('.doc-voice-pending span') as HTMLElement).textContent = f.pending;
    this.live.classList.toggle('hearing', f.pending.trim() !== '');
    this.live.classList.toggle('picking', f.picking);
    this.move.disabled = !f.canMove;
    this.drawAsk(f.on && !f.picking ? f.ask : null);
    this.place();
  }

  private drawAsk(a: LiveFrame['ask']): void {
    this.ask.hidden = !a;
    const key = a ? JSON.stringify(a) : '';
    // Rebuilt only when it changed: a draw comes with every word heard, and a
    // button replaced between press and release never gets its click.
    if (this.ask.dataset.key === key) return;
    this.ask.dataset.key = key;
    this.ask.replaceChildren();
    if (!a) return;
    this.ask.setAttribute('aria-label', a.question);
    const q = document.createElement('div');
    q.className = 'doc-voice-question';
    q.textContent = a.question;
    const row = document.createElement('div');
    row.className = 'doc-voice-choices';
    const button = (label: string, i?: number) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (i === undefined) b.className = 'doc-voice-keep';
      else b.dataset.i = String(i);
      row.append(b);
    };
    a.choices.forEach((c, i) => button(c, i));
    button('Keep as is');
    this.ask.append(q, row);
  }

  /** Under the live card, or over it when there is no room below. */
  private placeAsk(): void {
    if (this.ask.hidden) return;
    const r = this.live.getBoundingClientRect();
    const h = this.ask.offsetHeight;
    const vv = window.visualViewport;
    const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight) - 8;
    const below = this.live.classList.contains('float') || this.live.classList.contains('docked');
    const top = !below && r.bottom + 6 + h <= bottom ? r.bottom + 6 : Math.max(8, r.top - 6 - h);
    Object.assign(this.ask.style, { top: `${top}px`, left: `${r.left}px`, width: `${r.width}px` });
  }

  /** Stand the live card and the outline where they belong; runs on scroll. */
  place(): void {
    const f = this.frame;
    const el = f?.on && !f.picking ? f.passage : null;
    this.outline.hidden = !el;
    if (el) {
      const r = el.getBoundingClientRect();
      Object.assign(this.outline.style, {
        left: `${r.left - 4}px`,
        top: `${r.top - 3}px`,
        width: `${r.width + 8}px`,
        height: `${r.height + 6}px`,
      });
    }
    const docked = !balloonMarginVisible();
    const column = docked ? null : this.editorMount.querySelector('.markup-margin');
    const colRect = column?.getBoundingClientRect();
    const attached = !!f?.passage && !!colRect && colRect.width > 0;
    this.live.classList.toggle('docked', docked);
    this.live.classList.toggle('attached', attached);
    this.live.classList.toggle('float', !docked && !attached);
    if (!attached || !colRect || !f?.passage) {
      for (const p of ['top', 'left', 'width']) this.live.style.removeProperty(p);
      this.placeAsk();
      return;
    }
    const scroller = this.editorMount.getBoundingClientRect();
    const vv = window.visualViewport;
    const vvTop = vv?.offsetTop ?? 0;
    const slot = composerSlot({
      column: { left: colRect.left, width: colRect.width },
      anchorTop: f.passage.getBoundingClientRect().top,
      bounds: {
        top: Math.max(scroller.top, vvTop),
        // Above the mic, which sits over the bottom of the column.
        bottom: Math.min(scroller.bottom, vvTop + (vv?.height ?? innerHeight)) - 72,
      },
      height: this.live.offsetHeight,
    });
    Object.assign(this.live.style, {
      top: `${slot.top}px`,
      left: `${slot.left}px`,
      width: `${slot.width}px`,
    });
    this.placeAsk();
  }

  remove(): void {
    document.body.classList.remove('doc-voice-on', 'doc-voice-picking');
    this.outline.remove();
    this.live.remove();
    this.ask.remove();
    this.mic.remove();
    this.readout.remove();
  }
}
