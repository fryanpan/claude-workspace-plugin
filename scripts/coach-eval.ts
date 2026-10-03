#!/usr/bin/env bun
/**
 * The goal coach's two fixture weeks, judged by the real model.
 *
 * `bun scripts/coach-eval.ts`
 *
 * `coach-pass.test.ts` runs the same weeks with a stand-in judge, which
 * proves the plumbing and nothing about judgement. This is the other half:
 * every check the loop would make across each week, sent to Haiku through
 * the server's own summarizer, so the verdicts are the ones prod would get.
 *
 * SPENDS MONEY, on the eval key: outside the prod launchd job the
 * summarizer reads only the eval Keychain item (`claude-key-source.ts`), and
 * this script never sees the value. Fixture text only. A run is at most 40
 * calls of about 1,000 tokens each.
 *
 * Prints, per week, each check's outcome and the nudges raised, then the
 * prompt sizes the cost estimate rests on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TICK_MS, createCoach } from '../packages/server/src/coach/pass.ts';
import { CoachStore } from '../packages/server/src/coach/store.ts';
import { ThreadSummarizer } from '../packages/server/src/summarize.ts';
import {
  DRIFTING_WEEK,
  GOALS,
  ON_TRACK_WEEK,
  WEEK_END,
  WEEK_START,
  ZONE,
  at,
} from '../packages/server/test/coach-fixtures.ts';

const summarizer = new ThreadSummarizer();
if (!summarizer.enabled) {
  console.error('No eval key in this process; nothing was sent.');
  process.exit(2);
}

async function judgeWeek(name: string, rows: readonly { ts: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-eval-'));
  try {
    let clock = WEEK_START;
    const store = new CoachStore(dir, clock);
    store.setGoals(GOALS, ZONE, at(0, 8));
    const promptChars: number[] = [];
    const replyChars: number[] = [];
    const coach = createCoach({
      store,
      readRows: () => rows.filter((r) => Date.parse(r.ts) <= clock),
      label: () => ({}),
      generate: async (prompt) => {
        promptChars.push(prompt.system.length + prompt.user.length);
        const reply = await summarizer.generateHomeBrief(prompt);
        replyChars.push(reply?.length ?? 0);
        return reply;
      },
      now: () => clock,
      log: () => {},
    });
    for (clock = WEEK_START; clock < WEEK_END; clock += TICK_MS) await coach.tick();
    const outcomes = store.passes().map((p) => p.outcome);
    const counts = Object.fromEntries(
      [...new Set(outcomes)].map((o) => [o, outcomes.filter((x) => x === o).length]),
    );
    console.log(`\n== ${name}: ${promptChars.length} model calls`, counts);
    for (const day of [0, 1, 2, 3, 4]) {
      for (const n of store.nudgesToday(at(day, 12))) {
        console.log(`  nudge day ${day} goal ${n.goalIndex + 1}: ${n.question} | ${n.drift}`);
      }
    }
    return { promptChars, replyChars };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const a = await judgeWeek('on-track week', ON_TRACK_WEEK);
const b = await judgeWeek('drifting week', DRIFTING_WEEK);
const prompts = [...a.promptChars, ...b.promptChars];
const replies = [...a.replyChars, ...b.replyChars];
const mean = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length));
console.log(
  `\nprompt chars per call: mean ${mean(prompts)}, max ${Math.max(...prompts)}; reply chars mean ${mean(replies)}`,
);
