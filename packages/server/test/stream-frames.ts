/**
 * Read the event names off an open SSE response, for the folder and diff
 * watch tests.
 */
/** Every event name read off an open stream, until stopped. */
export function framesOf(
  res: Response,
  abort: AbortController,
): { names: () => string[]; stop: () => void } {
  const names: string[] = [];
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
          const name = /^event: (.+)$/m.exec(buf.slice(0, sep))?.[1];
          if (name) names.push(name);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  // Abort, not just cancel the reader: the server learns a page left only
  // when its connection closes.
  return { names: () => names, stop: () => abort.abort() };
}
