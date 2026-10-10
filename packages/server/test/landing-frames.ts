/**
 * Read `landing.changed` frames off an open `/landing/events:stream`
 * response: how many arrived, and which parts of `/` each one named.
 */
export interface LandingFrames {
  count: () => number;
  /** Every part named so far, across frames. */
  parts: () => Set<string>;
  stop: () => void;
}

export function landingFrames(res: Response): LandingFrames {
  let n = 0;
  const parts = new Set<string>();
  let buf = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buf.slice(0, sep);
          if (frame.includes('event: landing.changed')) {
            n += 1;
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            const body = data ? (JSON.parse(data.slice(6)) as { parts?: string[] }) : {};
            for (const p of body.parts ?? []) parts.add(p);
          }
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  return { count: () => n, parts: () => parts, stop: () => void reader.cancel() };
}
