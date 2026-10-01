import { describe, expect, it } from 'bun:test';
import {
  BackgroundPasses,
  InflightRegistry,
  LoopLagMonitor,
  SLICE_BUDGET_MS,
  timeSlice,
} from '../src/event-loop.ts';

/**
 * The clock is injected everywhere in this module precisely so these cases
 * cost no wall-clock time: the blocks under test are measured in seconds, and
 * a suite that waited them out would be the slowest file in the run for no
 * added confidence. Nothing here asserts on a real duration.
 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('LoopLagMonitor', () => {
  it('says nothing when ticks arrive on schedule', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    for (let i = 0; i < 20; i++) {
      clock.advance(250);
      m.tick();
    }
    expect(lines).toEqual([]);
    expect(m.reportCount()).toBe(0);
  });

  it('reports a turn that blocked past the threshold, with the blocked duration', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      stamp: () => 'STAMP',
      log: (l) => lines.push(l),
    });
    // The tick was due 250ms after construction; it arrives 14,500ms later,
    // so the loop was held for 14,250ms.
    clock.advance(14_500);
    m.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('blocked 14250ms');
    expect(m.reportCount()).toBe(1);
  });

  it('stays quiet just under the threshold and reports just over it', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 100,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    clock.advance(100 + 999);
    m.tick();
    expect(lines).toHaveLength(0);
    clock.advance(100 + 1000);
    m.tick();
    expect(lines).toHaveLength(1);
  });

  it('names the in-flight requests, oldest first, with how long each has been held', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const reg = new InflightRegistry(clock.now);
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      stamp: () => 'STAMP',
      log: (l) => lines.push(l),
      inflight: () => reg.snapshot(),
    });
    reg.enter({ method: 'POST', url: 'http://x/docs/d-1/suggestions/resolve_all' });
    clock.advance(500);
    reg.enter({ method: 'GET', url: 'http://x/api/deploy' });
    clock.advance(5_000);
    m.tick();

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    // Oldest first: the resolve_all started 5,500ms ago, the probe 5,000ms.
    const resolveAt = line.indexOf('/docs/d-1/suggestions/resolve_all');
    const deployAt = line.indexOf('/api/deploy');
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(deployAt).toBeGreaterThan(resolveAt);
    expect(line).toContain('POST /docs/d-1/suggestions/resolve_all (5500ms)');
    expect(line).toContain('GET /api/deploy (5000ms)');
  });

  it('calls out an empty in-flight set, because that points away from every handler', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      inflight: () => [],
    });
    clock.advance(9_000);
    m.tick();
    expect(lines[0]).toContain('nothing in flight');
  });

  it('reports what the process counters did across the block, not since boot', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    let counters = { cpuMs: 10_000, majorFaults: 500, heapMb: 170 };
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      sample: () => counters,
    });
    // An on-time tick moves the baseline, so the report below is the block's
    // own deltas and not everything since the monitor was built.
    clock.advance(250);
    counters = { cpuMs: 10_050, majorFaults: 510, heapMb: 172 };
    m.tick();
    // A 2.4s block: 300ms of CPU, 14,000 page-ins, and the heap collected.
    clock.advance(2_650);
    counters = { cpuMs: 10_350, majorFaults: 14_510, heapMb: 60 };
    m.tick();
    expect(lines[0]).toContain('across it: cpu 300ms, 14000 page-ins, heap 172→60MB');
  });

  it('summarises the tail rather than printing every held request', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const reg = new InflightRegistry(clock.now);
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      inflight: () => reg.snapshot(),
    });
    for (let i = 0; i < 9; i++) reg.enter({ method: 'GET', url: `http://x/r/${i}` });
    clock.advance(4_000);
    m.tick();
    expect(lines[0]).toContain('+6 more');
  });

  it('measures each block from the tick that observed it, so one block is reported once', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    clock.advance(12_000);
    m.tick();
    expect(lines).toHaveLength(1);
    // The next tick is on time relative to the one that just ran. A monitor
    // that kept measuring from the ORIGINAL due time would report the same
    // block again on every tick forever.
    clock.advance(250);
    m.tick();
    expect(lines).toHaveLength(1);
  });

  it('start arms a timer that cannot hold the process open, and stop is idempotent', () => {
    const m = new LoopLagMonitor({ periodMs: 10_000, log: () => {} });
    m.start();
    m.start();
    m.stop();
    m.stop();
    expect(m.reportCount()).toBe(0);
  });
});

describe('LoopLagMonitor naming the background pass', () => {
  /** A monitor over its own registry, and a clock the test moves. */
  function monitored() {
    const clock = fakeClock();
    const lines: string[] = [];
    const passes = new BackgroundPasses();
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      passes: () => passes.drain(),
    });
    return { clock, lines, passes, m };
  }

  it('names a synchronous pass that blocked, although it has finished by the report', () => {
    const { clock, lines, passes, m } = monitored();
    // The pass runs and returns inside the block; the monitor's late tick is
    // the first thing to run after it.
    passes.run('stall-tick', () => clock.advance(1_900));
    m.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('blocked 1650ms — nothing in flight; in pass: stall-tick');
    expect(lines[0]).not.toContain('a timer, a GC');
  });

  it('keeps the old sentence when no pass ran', () => {
    const { clock, lines, m } = monitored();
    clock.advance(1_900);
    m.tick();
    expect(lines[0]).toContain('nothing in flight; a timer, a GC, or the OS descheduling');
  });

  it('does not blame a pass that ran before the previous tick', () => {
    const { clock, lines, passes, m } = monitored();
    passes.run('idle-eviction', () => {});
    clock.advance(250);
    m.tick(); // on time: reads, and forgets, the eviction
    clock.advance(1_900);
    m.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('idle-eviction');
  });

  it('names a pass beside the requests in flight', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const passes = new BackgroundPasses();
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      inflight: () => [{ method: 'GET', path: '/workspaces', startedAt: 0 }],
      passes: () => passes.drain(),
    });
    passes.run('file-poll', () => clock.advance(2_000));
    m.tick();
    expect(lines[0]).toContain('in flight: GET /workspaces (2000ms); in pass: file-poll');
  });
});

describe('BackgroundPasses', () => {
  it('holds an async pass open until its promise settles', async () => {
    const passes = new BackgroundPasses();
    let finish!: () => void;
    const done = passes.run('stall-prepare', () => new Promise<void>((r) => (finish = r)));
    expect(passes.drain()).toEqual(['stall-prepare']);
    // Still running, so the next read names it again.
    expect(passes.drain()).toEqual(['stall-prepare']);
    finish();
    await done;
    expect(passes.drain()).toEqual(['stall-prepare']);
    expect(passes.drain()).toEqual([]);
  });

  it('ends a pass that throws, and a rejected one', async () => {
    const passes = new BackgroundPasses();
    expect(() =>
      passes.run('memory-sample', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await passes.run('ready-tick', () => Promise.reject(new Error('no'))).catch(() => {});
    expect(passes.drain()).toEqual(['memory-sample', 'ready-tick']);
    expect(passes.drain()).toEqual([]);
  });

  it('counts overlapping runs of one name, and an end called twice once', () => {
    const passes = new BackgroundPasses();
    const a = passes.enter('file-poll');
    const b = passes.enter('file-poll');
    a();
    a();
    passes.drain();
    expect(passes.drain()).toEqual(['file-poll']);
    b();
    passes.drain();
    expect(passes.drain()).toEqual([]);
  });
});

describe('InflightRegistry', () => {
  it('holds a request until its settle function runs', () => {
    const reg = new InflightRegistry(() => 0);
    const done = reg.enter({ method: 'GET', url: 'http://x/a' });
    expect(reg.size()).toBe(1);
    done();
    expect(reg.size()).toBe(0);
  });

  it('retires only its own entry when the same path is in flight twice', () => {
    const reg = new InflightRegistry(() => 0);
    const first = reg.enter({ method: 'GET', url: 'http://x/same' });
    reg.enter({ method: 'GET', url: 'http://x/same' });
    expect(reg.size()).toBe(2);
    first();
    expect(reg.size()).toBe(1);
  });

  it('records the pathname only, so a query string never reaches a log line', () => {
    const reg = new InflightRegistry(() => 0);
    reg.enter({ method: 'GET', url: 'http://x/workspaces/w-1/home?user=somebody' });
    expect(reg.snapshot()[0]?.path).toBe('/workspaces/w-1/home');
  });

  it('never throws on a url it cannot parse', () => {
    const reg = new InflightRegistry(() => 0);
    expect(() => reg.enter({ method: 'GET', url: 'not a url' })).not.toThrow();
    expect(reg.size()).toBe(1);
  });
});

describe('timeSlice', () => {
  it('does not yield while the budget is intact', async () => {
    const clock = fakeClock();
    const slice = timeSlice(50, clock.now);
    for (let i = 0; i < 100; i++) await slice.yieldIfDue();
    expect(slice.yields()).toBe(0);
  });

  it('yields once the budget is spent, and starts a fresh budget after', async () => {
    const clock = fakeClock();
    const slice = timeSlice(50, clock.now);
    clock.advance(50);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
    // Budget restarts from the yield, so the next item does not yield again.
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
    clock.advance(50);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(2);
  });

  it('actually hands the loop back, so a pending macrotask runs before it returns', async () => {
    const clock = fakeClock();
    const slice = timeSlice(10, clock.now);
    const order: string[] = [];
    // Queued before the yield; a microtask-only "yield" would not let it run.
    setImmediate(() => order.push('timer'));
    clock.advance(10);
    await slice.yieldIfDue();
    order.push('after-yield');
    expect(order).toEqual(['timer', 'after-yield']);
  });

  it('defaults to the documented budget', async () => {
    const clock = fakeClock();
    const slice = timeSlice(undefined, clock.now);
    clock.advance(SLICE_BUDGET_MS - 1);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(0);
    clock.advance(1);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
  });
});
