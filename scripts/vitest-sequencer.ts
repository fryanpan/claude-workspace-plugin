/**
 * The order a vitest run starts its files in: every file that may launch a
 * real browser first, then the rest, each half in vitest's own order.
 *
 * WHY. Vitest's default sort runs projects one after the other by NAME, so
 * every `dom` file is queued before any `node` file. On CI that left
 * `packages/plugin/test/check-mock-render.test.ts` (a node file, 56s, the
 * second-slowest in the suite) starting only once its shard's dom files had
 * drained, at +62s, and finishing alone at +119s while three workers sat
 * idle. That one queue position made client shard 4 the long pole (run
 * 36844754479: 123s of vitest against 69-94s for the other three).
 *
 * WHY THE BROWSER GATE IS THE SIGNAL. The 39 files that call `chromeForSuite`
 * are 6% of the suite's files and 70% of its measured test time on CI (476s of
 * 683s), and every one of the 20 slowest files but three is among them. A
 * file has to call it to launch a browser at all (`scripts/browser-tests.ts`),
 * so the signal cannot fall out of date the way a table of durations would.
 * Started first, they run beside the cheap files instead of after them.
 *
 * WHAT IT DOES NOT CHANGE. `shard` is vitest's own, so the split of files
 * into shards is exactly what it was, and with it every shard's tests and
 * lcov. Only the start order inside a shard moves. Locally, where the gate
 * is shut, those files skip their cases and the order costs nothing.
 */
import { readFileSync } from 'node:fs';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** The call a file must make to launch a browser (`scripts/browser-tests.ts`). */
const BROWSER_GATE = 'chromeForSuite(';

/**
 * `sorted`, with every file whose text calls the browser gate moved to the
 * front. Stable: each half keeps the order it arrived in.
 */
export function browserFirst<T>(sorted: readonly T[], callsGate: (file: T) => boolean): T[] {
  const browser: T[] = [];
  const rest: T[] = [];
  for (const file of sorted) (callsGate(file) ? browser : rest).push(file);
  return [...browser, ...rest];
}

/** Does the file at `path` call the browser gate? An unreadable file does not. */
export function callsBrowserGate(path: string, read = (p: string) => readFileSync(p, 'utf8')) {
  try {
    return read(path).includes(BROWSER_GATE);
  } catch {
    return false;
  }
}

export class BrowserFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return browserFirst(sorted, (spec) => callsBrowserGate(spec.moduleId));
  }
}
