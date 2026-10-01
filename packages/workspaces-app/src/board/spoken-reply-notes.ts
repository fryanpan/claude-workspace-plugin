/**
 * A spoken reply's notes, shown in step with the voice.
 *
 * The server sends each point's note just before that point's audio, and the
 * audio is queued behind whatever is still playing — so a note can arrive
 * seconds before its point is heard. Shown on arrival, the second note would
 * sit on the page while the first point is still being said. Instead each note
 * waits for the play time of its point's first audible sample and shows
 * `NOTE_LEAD_MS` before it: written just before it is said.
 *
 * Each note's lead — shown minus first word played, so negative is early — is
 * kept for the turn's `timing` report, which logs it on the server's
 * `[spoken-reply]` line.
 */
import type { SpokenPlayer } from './spoken-reply-audio.ts';

/** How far ahead of its point's first word a note shows. */
export const NOTE_LEAD_MS = 150;

export interface NoteClockOpts {
  player: Pick<SpokenPlayer, 'mark'>;
  /** Show point `point`'s note. */
  land(point: number, text: string): void;
  now(): number;
}

export interface NoteClock {
  /** A note frame arrived. */
  note(point: number, text: string): void;
  /** Speech ended or stopped: show every note still waiting, untimed. */
  flush(): void;
  /** The leads measured so far, in point order. */
  leads(): number[];
  /** A new reply: forget the last one's notes and timers. */
  reset(): void;
}

export function createNoteClock(opts: NoteClockOpts): NoteClock {
  let gen = 0;
  const waiting = new Map<number, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let measured = new Map<number, number>();

  const show = (point: number, text: string, audibleAt: number | null): void => {
    if (!waiting.has(point)) return;
    waiting.delete(point);
    opts.land(point, text);
    if (audibleAt !== null) measured.set(point, opts.now() - audibleAt);
  };

  return {
    note(point, text) {
      const mine = gen;
      waiting.set(point, text);
      opts.player.mark((audibleAt) => {
        if (mine !== gen) return;
        const wait = audibleAt - NOTE_LEAD_MS - opts.now();
        if (wait <= 0) return show(point, text, audibleAt);
        const t = setTimeout(() => {
          timers.delete(t);
          if (mine === gen) show(point, text, audibleAt);
        }, wait);
        timers.add(t);
      });
    },
    flush() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const [point, text] of [...waiting]) show(point, text, null);
    },
    leads() {
      return [...measured.entries()].sort((a, b) => a[0] - b[0]).map(([, ms]) => Math.round(ms));
    },
    reset() {
      gen++;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      waiting.clear();
      measured = new Map();
    },
  };
}
