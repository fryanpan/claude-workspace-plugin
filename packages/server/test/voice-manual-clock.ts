/** Timers that fire only when the test moves the clock past them. */
export function manualClock() {
  let now = 0;
  const pending = new Set<{ fn: () => void; at: number }>();
  return {
    now: () => now,
    timers: {
      set: (fn: () => void, ms: number) => {
        const t = { fn, at: now + ms };
        pending.add(t);
        return t;
      },
      clear: (h: unknown) => {
        pending.delete(h as { fn: () => void; at: number });
      },
    },
    advance(ms: number): void {
      now += ms;
      for (const t of [...pending].sort((a, b) => a.at - b.at)) {
        if (t.at > now || !pending.has(t)) continue;
        pending.delete(t);
        t.fn();
      }
    },
  };
}
