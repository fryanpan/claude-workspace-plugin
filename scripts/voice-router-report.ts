/**
 * The router eval's arithmetic: accuracy by page kind, latency by path, the
 * misroute classes ranked, and how well a classifier's confidence separates
 * its right picks from its wrong ones. Pure, so it is tested on its own.
 */
import { PAGE_KINDS, type PageKind, type RouterCase } from './voice-router-corpus.ts';
import type { CaseRun, RouterPath } from './voice-router-run.ts';

export interface Scored {
  case: RouterCase;
  run: CaseRun;
  right: boolean;
}

export interface KindRow {
  kind: PageKind | 'all';
  right: number;
  total: number;
}

export function accuracyByKind(rows: readonly Scored[]): KindRow[] {
  const out: KindRow[] = PAGE_KINDS.map((kind) => {
    const of = rows.filter((r) => r.case.kind === kind);
    return { kind, right: of.filter((r) => r.right).length, total: of.length };
  });
  out.push({ kind: 'all', right: rows.filter((r) => r.right).length, total: rows.length });
  return out;
}

/** The value at fraction `p` of the sorted list (nearest rank). */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[at];
}

export interface PathRow {
  path: RouterPath;
  n: number;
  medianMs?: number;
  p90Ms?: number;
  /** Of these, how many asked the classifier, and its own median. */
  asked: number;
  classifierMedianMs?: number;
}

export function latencyByPath(rows: readonly Scored[]): PathRow[] {
  return (['server', 'model', 'agent'] as const).map((path) => {
    const of = rows.filter((r) => r.run.path === path);
    const ms = of.map((r) => r.run.ms);
    const cls = of.flatMap((r) => (r.run.classifierMs !== undefined ? [r.run.classifierMs] : []));
    const median = percentile(ms, 0.5);
    const p90 = percentile(ms, 0.9);
    const cMedian = percentile(cls, 0.5);
    return {
      path,
      n: of.length,
      ...(median !== undefined ? { medianMs: median } : {}),
      ...(p90 !== undefined ? { p90Ms: p90 } : {}),
      asked: cls.length,
      ...(cMedian !== undefined ? { classifierMedianMs: cMedian } : {}),
    };
  });
}

function outcomeType(o: CaseRun['observed']): string {
  return Object.keys(o)[0] ?? 'none';
}

/** What kind of wrong a miss is. */
export function misrouteClass(s: Scored): string {
  const want = outcomeType(s.case.expect);
  const got = outcomeType(s.run.observed);
  if (want === got) {
    if (want === 'open') return 'opened a neighbour';
    if (want === 'answer') return 'answered with the wrong option';
    return `${want}: right verb, wrong target`;
  }
  if (got === 'agent') {
    const label: Record<string, string> = {
      open: 'a lookup the server should open went to the agent',
      brief: 'a status question went to the agent',
      answer: 'a review answer went to the agent',
      status: 'a status move went to the agent',
      assign: 'an assignment went to the agent',
      comment: 'a comment went to the agent',
      ask: 'an ambiguous name went to the agent',
    };
    return label[want] ?? `${want} went to the agent`;
  }
  if (want === 'agent') return `acted on something the agent owned (${got})`;
  return `${want} came out as ${got}`;
}

export interface ClassRow {
  label: string;
  count: number;
  examples: string[];
}

export function misrouteClasses(rows: readonly Scored[]): ClassRow[] {
  const by = new Map<string, ClassRow>();
  for (const r of rows) {
    if (r.right) continue;
    const label = misrouteClass(r);
    const row = by.get(label) ?? { label, count: 0, examples: [] };
    row.count++;
    if (row.examples.length < 3) row.examples.push(`${r.case.kind}: "${r.case.said}"`);
    by.set(label, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface Separation {
  /** Cases with a confidence. */
  n: number;
  /** Probability a random right pick is more confident than a random wrong one. */
  auc?: number;
  /** Wrong picks at or above 0.9, of all picks at or above 0.9. */
  wrongAtHigh: number;
  high: number;
}

export function confidenceSeparation(rows: readonly Scored[]): Separation {
  const withConf = rows.filter((r) => r.run.confidence !== undefined);
  const right = withConf.filter((r) => r.right).map((r) => r.run.confidence as number);
  const wrong = withConf.filter((r) => !r.right).map((r) => r.run.confidence as number);
  let auc: number | undefined;
  if (right.length > 0 && wrong.length > 0) {
    let wins = 0;
    for (const a of right) for (const b of wrong) wins += a > b ? 1 : a === b ? 0.5 : 0;
    auc = wins / (right.length * wrong.length);
  }
  const high = withConf.filter((r) => (r.run.confidence as number) >= 0.9);
  return {
    n: withConf.length,
    ...(auc !== undefined ? { auc } : {}),
    wrongAtHigh: high.filter((r) => !r.right).length,
    high: high.length,
  };
}
