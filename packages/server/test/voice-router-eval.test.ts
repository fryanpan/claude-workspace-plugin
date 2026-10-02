/**
 * The router eval's harness, driven with a stub classifier so it costs
 * nothing: the corpus meets its own size bar, a case is scored on what the
 * real router did over the fixture board, and the report arithmetic adds up.
 */
import { describe, expect, it } from 'bun:test';
import {
  PAGE_KINDS,
  ROUTER_CORPUS,
  type RouterCase,
} from '../../../scripts/voice-router-corpus.ts';
import {
  type Scored,
  accuracyByKind,
  confidenceSeparation,
  misrouteClasses,
  percentile,
} from '../../../scripts/voice-router-report.ts';
import { runCase, scored } from '../../../scripts/voice-router-run.ts';
import type { VoiceClassifier } from '../src/voice-classifier.ts';

const agentOnly: VoiceClassifier = async () => ({ classification: { kind: 'change' } });

const find = (said: string): RouterCase => {
  const c = ROUTER_CORPUS.find((x) => x.said === said);
  if (!c) throw new Error(`no corpus case "${said}"`);
  return c;
};

describe('the corpus', () => {
  it('holds at least 60 utterances over all six page kinds, with near misses', () => {
    expect(ROUTER_CORPUS.length).toBeGreaterThanOrEqual(60);
    for (const k of PAGE_KINDS)
      expect(
        ROUTER_CORPUS.some((c) => c.kind === k),
        k,
      ).toBe(true);
    expect(ROUTER_CORPUS.filter((c) => c.near).length).toBeGreaterThanOrEqual(10);
  });
});

describe('runCase', () => {
  it('answers a status question with the brief, on a mock, with no model asked', async () => {
    const c = find("what's left on the board");
    const run = await runCase(c, agentOnly);
    expect(run.observed).toEqual({ brief: true });
    expect(run.path).toBe('server');
    expect(scored(c, run.observed)).toBe(true);
  });

  it('opens a goal by its rank on the server path', async () => {
    const run = await runCase(find('open my top goal'), agentOnly);
    expect(run.observed).toEqual({ open: 'crossing' });
  });

  it('sees a status move the classifier asked for, through the real guardrail', async () => {
    const c = find('mark this done');
    const run = await runCase(c, async ({ resource }) => ({
      classification: {
        kind: 'action',
        action: 'set-status',
        status: 'done',
        id: resource?.id ?? '',
      },
      confidence: 0.7,
    }));
    expect(run.observed).toEqual({ status: 'timetable', to: 'done' });
    expect(run.path).toBe('model');
    expect(run.confidence).toBe(0.7);
  });

  it('scores a neighbour opened by the classifier as a miss', async () => {
    const c = find('open the tide table task');
    const run = await runCase(c, async ({ index }) => ({
      classification: {
        kind: 'lookup',
        target: 'task',
        id: index.tasks.find((t) => t.title.startsWith('Tide survey'))?.id ?? '',
      },
    }));
    expect(run.observed).toEqual({ open: 'tide' });
    expect(scored(c, run.observed)).toBe(false);
  });
});

describe('the report', () => {
  const row = (said: string, observed: Scored['run']['observed'], confidence?: number): Scored => {
    const c = find(said);
    return {
      case: c,
      run: {
        observed,
        path: 'model',
        asked: true,
        ms: 1,
        ...(confidence !== undefined ? { confidence } : {}),
      },
      right: scored(c, observed),
    };
  };

  it('counts accuracy per kind and overall', () => {
    const rows = [
      row('mark this done', { status: 'timetable', to: 'done' }),
      row('assign this to Bob', { agent: true }),
    ];
    const task = accuracyByKind(rows).find((k) => k.kind === 'task');
    expect(task).toEqual({ kind: 'task', right: 1, total: 2 });
  });

  it('ranks misses by class, most frequent first', () => {
    const classes = misrouteClasses([
      row('assign this to Bob', { agent: true }),
      row('assign it to me', { agent: true }),
      row('open the tide table task', { open: 'tide' }),
    ]);
    expect(classes.map((c) => [c.label, c.count])).toEqual([
      ['an assignment went to the agent', 2],
      ['acted on something the agent owned (open)', 1],
    ]);
  });

  it('scores separation as 1 when every right pick is more confident than every wrong one', () => {
    const sep = confidenceSeparation([
      row('mark this done', { status: 'timetable', to: 'done' }, 0.95),
      row('open the tide table task', { open: 'tide' }, 0.6),
    ]);
    expect(sep).toEqual({ n: 2, auc: 1, wrongAtHigh: 0, high: 1 });
  });

  it('takes the nearest-rank percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});
