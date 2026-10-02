/**
 * The planning voice's part of the meeting bar, shown while the voice hears
 * this page's meeting: one steady line naming what Claude is working on after
 * a "Claude, …" the lead took ("Claude · find the ferry fares…"), gone when
 * the answer is in, and the pause setting, so the owner can try other waits
 * in the middle of a meeting.
 *
 * The setting is per device, as zoom-dependent facts are: kept in this
 * browser's storage and sent with every `start` and on every change. Storage
 * that throws or holds nonsense leaves the server's defaults.
 *
 * Calm and still: the line keeps its width whether it is showing or not, and
 * the setting's label keeps its shape as the numbers change, so nothing
 * beside them moves.
 */
import {
  SPOKEN_PAUSE_DEFAULT,
  type SpokenPause,
  parseSpokenPause,
} from '@claude-workspaces/core/spoken-reply';
import type { MountScope } from '../mount-scope.ts';

export const PAUSE_KEY = 'cw-spoken-pause';
/** The waits offered, in ms: after a finished sentence, and after an unfinished one. */
export const FINISHED_CHOICES = [1000, 1500, 2000, 2500, 3000] as const;
export const UNFINISHED_CHOICES = [2000, 3000, 4000, 5000, 6000] as const;

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** This device's pause setting, or the defaults. */
export function storedPause(storage: Store): SpokenPause {
  try {
    const raw = storage?.getItem(PAUSE_KEY);
    return (raw && parseSpokenPause(JSON.parse(raw))) || SPOKEN_PAUSE_DEFAULT;
  } catch {
    return SPOKEN_PAUSE_DEFAULT;
  }
}

/** The page's own storage, or null where reaching it throws. */
export function pageStorage(): Store {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function savePause(storage: Store, p: SpokenPause): void {
  try {
    storage?.setItem(PAUSE_KEY, JSON.stringify(p));
  } catch {
    // Private mode or blocked storage: the setting lasts this page only.
  }
}

const secs = (ms: number): string => `${ms / 1000}s`;

export class MeetingVoiceBar {
  readonly root: HTMLDivElement;
  readonly line: HTMLSpanElement;
  readonly setting: HTMLButtonElement;
  readonly pop: HTMLDivElement;
  readonly finished: HTMLSelectElement;
  readonly unfinished: HTMLSelectElement;
  private pause: SpokenPause;

  constructor(opts: {
    host: HTMLElement;
    scope: MountScope;
    storage: Store;
    /** The setting changed. */
    onPause: (p: SpokenPause) => void;
  }) {
    const doc = opts.host.ownerDocument;
    this.pause = storedPause(opts.storage);
    this.root = doc.createElement('div');
    this.root.className = 'meeting-voice';
    this.root.hidden = true;
    this.line = doc.createElement('span');
    this.line.className = 'meeting-voice-doing';
    this.line.setAttribute('aria-live', 'polite');
    this.setting = doc.createElement('button');
    this.setting.type = 'button';
    this.setting.className = 'meeting-voice-pause';
    this.setting.setAttribute('aria-expanded', 'false');
    this.setting.title = 'How long Claude waits for a pause before it speaks';
    this.pop = doc.createElement('div');
    this.pop.className = 'meeting-voice-pop';
    this.pop.hidden = true;
    const pick = (label: string, choices: readonly number[], now: number) => {
      const wrap = doc.createElement('label');
      wrap.textContent = label;
      const sel = doc.createElement('select');
      for (const ms of choices) {
        const o = doc.createElement('option');
        o.value = String(ms);
        o.textContent = secs(ms);
        sel.append(o);
      }
      sel.value = String(now);
      wrap.append(sel);
      this.pop.append(wrap);
      return sel;
    };
    this.finished = pick('After a finished sentence', FINISHED_CHOICES, this.pause.finishedMs);
    this.unfinished = pick(
      'After an unfinished phrase',
      UNFINISHED_CHOICES,
      this.pause.unfinishedMs,
    );
    this.root.append(this.line, this.setting, this.pop);
    opts.host.append(this.root);
    this.drawSetting();

    const changed = (): void => {
      const p = parseSpokenPause({
        finishedMs: Number(this.finished.value),
        unfinishedMs: Number(this.unfinished.value),
      });
      if (!p) return;
      this.pause = p;
      savePause(opts.storage, p);
      this.drawSetting();
      opts.onPause(p);
    };
    opts.scope.listen(this.finished, 'change', changed);
    opts.scope.listen(this.unfinished, 'change', changed);
    opts.scope.listen(this.setting, 'click', () => this.openPop(this.pop.hidden));
    opts.scope.listen(doc, 'pointerdown', (ev) => {
      if (!this.pop.hidden && !this.root.contains(ev.target as Node)) this.openPop(false);
    });
    opts.scope.listen(doc, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') this.openPop(false);
    });
  }

  /** The setting the next `start` carries. */
  get current(): SpokenPause {
    return this.pause;
  }

  show(on: boolean): void {
    this.root.hidden = !on;
    if (!on) {
      this.openPop(false);
      this.doing(null);
    }
  }

  /** What Claude is working on, in a few words; null when the answer is in. */
  doing(label: string | null): void {
    this.line.classList.toggle('is-on', label !== null);
    this.line.textContent = label === null ? '' : `Claude · ${label}…`;
  }

  remove(): void {
    this.root.remove();
  }

  private openPop(open: boolean): void {
    this.pop.hidden = !open;
    this.setting.setAttribute('aria-expanded', String(open));
  }

  private drawSetting(): void {
    this.setting.textContent = `Pause ${secs(this.pause.finishedMs)} · ${secs(this.pause.unfinishedMs)}`;
  }
}
