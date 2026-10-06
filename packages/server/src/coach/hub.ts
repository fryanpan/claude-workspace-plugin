import { type SseStreamWriter, createSseStreamWriter } from '../sse-writer.ts';
/**
 * The coach's own event stream, `GET /coach/stream`: the moment, to every
 * page the owner has open, and its clearing once he answers it in any of them.
 *
 * Its own stream rather than a board channel because a board channel
 * reaches every member of that board, and a moment is his alone. It carries
 * nothing else, so a page holding it learns only what the coach says.
 *
 * A page that connects while a moment is open gets it at once, wherever it
 * is: a moment follows him from page to page until he answers it. Each page
 * says where it is when it connects (`?workspaceId=&docId=`; the front page
 * names nowhere), and a page on a board the coach is excluded from is never
 * sent the moment. When a board becomes off or on again, `reshow` tells each
 * page anew: a clear where it is now hidden, the moment where it may show.
 *
 * Writes go through `createSseStreamWriter`, like every other stream here,
 * for the macOS hold that file explains.
 */
import { SSE_KEEPALIVE_MS } from '../sse.ts';
import type { CoachFrame } from './moment.ts';

/** One person's tabs; past this the oldest is closed. */
export const MAX_COACH_STREAMS = 24;

const frameText = (f: CoachFrame) => `event: coach\ndata: ${JSON.stringify(f)}\n\n`;

/** Where a page is: a board, a doc on one, or null for the front page. */
export type CoachPagePlace = { workspaceId: string; docId?: string } | null;

export interface CoachHubOptions {
  keepaliveMs?: number;
  /** True when the coach is excluded from this place (`coach/exclusion.ts`),
   *  so a page there must not show the moment. */
  hiddenAt?: (place: { workspaceId: string; docId?: string }) => boolean;
}

export class CoachHub {
  /** Each open page, and where it is. */
  private readonly sinks = new Map<SseStreamWriter, CoachPagePlace>();
  private readonly keepaliveMs: number;
  private readonly hiddenAt: (place: { workspaceId: string; docId?: string }) => boolean;

  constructor(opts: CoachHubOptions = {}) {
    this.keepaliveMs = opts.keepaliveMs ?? SSE_KEEPALIVE_MS;
    this.hiddenAt = opts.hiddenAt ?? (() => false);
  }

  /** What a page at `place` is sent for `frame`: a moment is a clear where
   *  the coach is excluded. A check that throws counts as excluded. */
  private frameAt(frame: CoachFrame, place: CoachPagePlace): CoachFrame {
    if (frame.type !== 'moment' || place === null) return frame;
    let hidden: boolean;
    try {
      hidden = this.hiddenAt(place);
    } catch {
      hidden = true;
    }
    return hidden ? { type: 'clear', id: frame.moment.id } : frame;
  }

  get size(): number {
    return this.sinks.size;
  }

  open(initial: CoachFrame | null, place: CoachPagePlace = null): Response {
    let writer: SseStreamWriter | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const sinks = this.sinks;
    const drop = () => {
      if (keepalive) clearInterval(keepalive);
      if (writer) sinks.delete(writer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        const w = createSseStreamWriter(c);
        writer = w;
        if (sinks.size >= MAX_COACH_STREAMS) {
          const oldest = sinks.keys().next().value;
          if (oldest) {
            sinks.delete(oldest);
            oldest.close();
          }
        }
        sinks.set(w, place);
        w.write(':ok\n\n');
        const first = initial ? this.frameAt(initial, place) : null;
        if (first?.type === 'moment') w.write(frameText(first));
        keepalive = setInterval(() => {
          try {
            w.write(':ka\n\n');
          } catch {
            drop();
          }
        }, this.keepaliveMs);
        keepalive.unref?.();
      },
      cancel: () => {
        writer?.cancel();
        drop();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  /** A new moment to every page that may show it, or its clearing to every
   *  page. A page where it is hidden is not sent the moment at all. */
  publish(frame: CoachFrame): void {
    this.send((place) => {
      const f = this.frameAt(frame, place);
      return f === frame ? f : null;
    });
  }

  /** The open moment, told to every page again: shown where it may be, a
   *  clear where it is hidden now. */
  reshow(frame: CoachFrame | null): void {
    if (frame) this.send((place) => this.frameAt(frame, place));
  }

  private send(frameFor: (place: CoachPagePlace) => CoachFrame | null): void {
    for (const [w, place] of [...this.sinks]) {
      const f = frameFor(place);
      if (!f) continue;
      try {
        w.write(frameText(f));
      } catch {
        this.sinks.delete(w);
      }
    }
  }

  close(): void {
    for (const w of this.sinks.keys()) w.close();
    this.sinks.clear();
  }
}
