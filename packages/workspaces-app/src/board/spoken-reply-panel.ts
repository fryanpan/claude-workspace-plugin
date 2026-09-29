/**
 * The reply panel above the board mic — the approved mock's markup and
 * states, and nothing else. What drives it is `spoken-reply-client.ts`.
 *
 * Calm by default: the one indicator is a steady dot whose colour names the
 * state (red while listening, filled blue while Claude speaks or asks, a blue
 * ring while it waits for an answer). The state label is sized for its widest
 * value, so Stop and × never move, and the panel keeps one height from open
 * to close — the body scrolls instead.
 */
import {
  SPOKEN_SETUPS,
  SPOKEN_SETUP_NAMES,
  SPOKEN_SETUP_TITLES,
  type SpokenSetup,
  type SpokenTimingRow,
} from '@claude-workspaces/core/spoken-reply';

export type SpokenPanelState =
  | 'idle'
  | 'listening'
  | 'sending'
  | 'writing'
  | 'speaking'
  | 'asking'
  | 'waiting'
  | 'done'
  | 'stopped';

export const SPOKEN_STATE_LABELS: Record<SpokenPanelState, string> = {
  idle: '',
  listening: 'Listening',
  sending: 'Heard you',
  writing: 'Writing',
  speaking: 'Speaking',
  asking: 'Asking you',
  waiting: 'Waiting for your answer',
  done: 'Done',
  stopped: 'Stopped',
};

export interface SpokenPanelOpts {
  document: Document;
  /** The mic the panel sits above. */
  anchor: HTMLElement;
  /** The setups this server can run; the others are shown, and disabled. */
  setups: readonly SpokenSetup[];
  onStop(): void;
  onClose(): void;
  onPickSetup(setup: SpokenSetup): void;
  onChoice(text: string): void;
}

export interface SpokenPanel {
  readonly root: HTMLElement;
  state(): SpokenPanelState;
  setState(s: SpokenPanelState): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  setYou(text: string): void;
  clearBody(): void;
  reply(r: { spoken: string; detail: readonly string[]; choices?: readonly string[] }): void;
  note(text: string): void;
  setSetup(setup: SpokenSetup): void;
  /** This answer's delay (`undefined` keeps the one shown), and the setup's
   *  running figures. */
  setDelay(ms: number | null | undefined, row?: SpokenTimingRow): void;
  destroy(): void;
}

const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 340;
const GUTTER = 16;

/** The feedback widget's corner buttons sit at the maximum z-index, so at
 *  430px they covered the panel's footer. The panel cannot out-stack them
 *  (they must stay tappable); it ends above any it would overlap instead. */
export function widgetButtonRects(doc: Document): DOMRect[] {
  const root = doc.querySelector('claude-feedback-widget')?.shadowRoot;
  if (!root) return [];
  return [...root.querySelectorAll('button')]
    .map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
}

export function createSpokenPanel(opts: SpokenPanelOpts): SpokenPanel {
  const doc = opts.document;
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const root = make('section', 'vr-panel hidden');
  root.id = 'vr-panel';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Claude’s reply');
  root.dataset.state = 'idle';

  const head = make('header', 'vr-head');
  const dot = make('span', 'vr-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = make('span', 'vr-state');
  label.setAttribute('aria-live', 'polite');
  const stop = make('button', 'vr-stop', 'Stop');
  stop.type = 'button';
  stop.disabled = true;
  const close = make('button', 'vr-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  head.append(dot, label, make('span', 'vr-spacer'), stop, close);

  const scroll = make('div', 'vr-scroll');
  const you = make('p', 'vr-you');
  const youText = make('span', 'vr-you-text');
  you.append(make('span', 'vr-kicker', 'You'), youText);
  const body = make('div', 'vr-body');
  scroll.append(you, body);

  const foot = make('footer', 'vr-foot');
  const setupRow = make('span', 'vr-setup-row');
  const group = make('span', 'vr-setups');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Voice setup under test');
  const buttons = new Map<SpokenSetup, HTMLButtonElement>();
  for (const s of SPOKEN_SETUPS) {
    const b = make('button', undefined, String(s));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.setup = String(s);
    const can = opts.setups.includes(s);
    b.disabled = !can;
    b.title = can
      ? SPOKEN_SETUP_TITLES[s]
      : `${SPOKEN_SETUP_TITLES[s]} — not set up on this server`;
    b.addEventListener('click', () => opts.onPickSetup(s));
    buttons.set(s, b);
    group.append(b);
  }
  const setupName = make('span', 'vr-setup-name');
  setupRow.append(group, setupName);
  const delay = make('span', 'vr-delay');
  const delayMs = make('b', undefined, '—');
  const delayRun = make('span', 'vr-delay-run');
  delay.append('End of question → first spoken word ', delayMs, ' ms', delayRun);
  foot.append(make('span', undefined, 'Setup'), setupRow, make('span', undefined, 'Delay'), delay);

  root.append(head, scroll, foot);
  doc.body.append(root);

  let current: SpokenPanelState = 'idle';

  const place = (): void => {
    if (root.classList.contains('hidden')) return;
    const view = doc.defaultView;
    const vw = doc.documentElement.clientWidth;
    const vh = view?.innerHeight ?? 0;
    const r = opts.anchor.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, vw - 2 * GUTTER);
    let left = Math.max(GUTTER, r.left);
    if (left + width > vw - GUTTER) left = vw - GUTTER - width;
    root.style.width = `${width}px`;
    root.style.left = `${left}px`;
    if (r.top > vh / 2) {
      // Stacked buttons: moving above one can land on the next, so repeat.
      const buttons = widgetButtonRects(doc).filter((b) => b.left < left + width && b.right > left);
      let edge = r.top;
      for (let moved = true; moved; ) {
        moved = false;
        for (const b of buttons) {
          if (b.top < edge - 8 && b.bottom > edge - PANEL_HEIGHT - 8) {
            edge = b.top;
            moved = true;
          }
        }
      }
      const bottom = vh - edge + 8;
      root.style.bottom = `${bottom}px`;
      root.style.top = 'auto';
      root.style.height = `${Math.max(160, Math.min(PANEL_HEIGHT, vh - bottom - 64))}px`;
    } else {
      root.style.top = `${r.bottom + 8}px`;
      root.style.bottom = 'auto';
      root.style.height = `${Math.max(160, Math.min(PANEL_HEIGHT, vh - r.bottom - 24))}px`;
    }
  };
  const onResize = (): void => place();
  doc.defaultView?.addEventListener('resize', onResize);

  stop.addEventListener('click', () => opts.onStop());
  close.addEventListener('click', () => opts.onClose());

  const spokenBlock = (text: string): HTMLParagraphElement => {
    const p = make('p', 'vr-spoken');
    p.append(make('span', 'vr-kicker', 'Spoken'), make('span', undefined, text));
    return p;
  };

  return {
    root,
    state: () => current,
    setState(s) {
      current = s;
      root.dataset.state = s;
      label.textContent = SPOKEN_STATE_LABELS[s];
      stop.disabled = !(s === 'speaking' || s === 'asking');
      opts.anchor.classList.toggle('voice-active', s === 'listening');
      opts.anchor.title =
        s === 'speaking' || s === 'asking' ? 'Hold to interrupt' : 'Hold to talk (or hold Space)';
    },
    open() {
      root.classList.remove('hidden');
      place();
    },
    close() {
      root.classList.add('hidden');
    },
    isOpen: () => !root.classList.contains('hidden'),
    setYou(text) {
      youText.textContent = text;
    },
    clearBody() {
      body.replaceChildren();
    },
    reply(r) {
      body.replaceChildren();
      if (r.spoken) body.append(spokenBlock(r.spoken));
      if (r.choices && r.choices.length > 0) {
        const row = make('div', 'vr-choices');
        for (const c of r.choices) {
          const b = make('button', undefined, c);
          b.type = 'button';
          b.addEventListener('click', () => opts.onChoice(c));
          row.append(b);
        }
        body.append(row);
      }
      if (r.detail.length > 0) {
        const list = make('ul', 'vr-detail');
        for (const line of r.detail) list.append(make('li', undefined, line));
        body.append(list);
      }
    },
    note(text) {
      body.append(make('p', 'vr-note', text));
    },
    setSetup(setup) {
      for (const [s, b] of buttons) b.setAttribute('aria-checked', String(s === setup));
      setupName.textContent = SPOKEN_SETUP_NAMES[setup];
    },
    setDelay(ms, row) {
      if (ms !== undefined) delayMs.textContent = ms === null ? '—' : String(Math.round(ms));
      delayRun.textContent = row ? ` · median ${row.medianMs} of ${row.n}` : '';
    },
    destroy() {
      doc.defaultView?.removeEventListener('resize', onResize);
      root.remove();
    },
  };
}
