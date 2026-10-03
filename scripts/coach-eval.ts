#!/usr/bin/env bun
/**
 * The coach's fixture days, judged by the real model.
 *
 * `bun scripts/coach-eval.ts`
 *
 * `coach-moment.test.ts` runs the same days with a stand-in judge, which
 * proves the plumbing and nothing about judgement. This is the other half,
 * in two parts:
 *
 *  1. Each labelled point of the drifting day (`LABELLED_POINTS`): the day
 *     replayed up to that instant, the prompt the coach would send, and
 *     whether the model spoke or stayed quiet where a good coach would.
 *     Every point is asked, whatever the gates would have said, so each
 *     label is tested.
 *  2. The on-track day through the whole loop, gates and all: the number of
 *     calls a quiet day costs, and the moments it raised (zero is right).
 *
 * SPENDS MONEY, on the eval key: outside the prod launchd job the
 * summarizer reads only the eval Keychain item (`claude-key-source.ts`), and
 * this script never sees the value. Fixture text only. A run is about 20
 * calls of under 2,000 tokens each.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionableGoals, readGoalsDoc } from '../packages/server/src/coach/goals-doc.ts';
import { coachPrompt, coachSystem, parseCoachReply } from '../packages/server/src/coach/judge.ts';
import { createCoach } from '../packages/server/src/coach/moment.ts';
import { CoachStore } from '../packages/server/src/coach/store.ts';
import { CoachStream } from '../packages/server/src/coach/stream.ts';
import { ThreadSummarizer } from '../packages/server/src/summarize.ts';
import {
  DAY_END,
  DAY_START,
  DRIFTING_DAY,
  GOALS_DOC,
  LABELLED_POINTS,
  ON_TRACK_DAY,
  type Signal,
  WS,
  ZONE,
  label,
} from '../packages/server/test/coach-fixtures.ts';

const summarizer = new ThreadSummarizer();
if (!summarizer.enabled) {
  console.error('No eval key in this process; nothing was sent.');
  process.exit(2);
}

const reading = readGoalsDoc(GOALS_DOC);
const goals = actionableGoals(reading);
const name = reading.name ?? 'Your coach';
const boardName = () => 'Harborlight';
const workspaceOf = () => WS;
const promptChars: number[] = [];
const replyChars: number[] = [];

async function ask(prompt: { system: string; user: string }): Promise<string | null> {
  promptChars.push(prompt.system.length + prompt.user.length);
  const reply = await summarizer.generateHomeBrief(prompt);
  replyChars.push(reply?.length ?? 0);
  return reply;
}

function replay(stream: CoachStream, signals: readonly Signal[], until: number): void {
  for (const s of signals) {
    if (s.at > until) break;
    if ('here' in s) stream.here({ ...s.here, at: s.at });
    else stream.activity(s.row, s.at, workspaceOf);
  }
}

console.log('== the drifting day, at each labelled point');
let right = 0;
for (const point of LABELLED_POINTS) {
  const stream = new CoachStream();
  replay(stream, DRIFTING_DAY, point.at);
  const seen = stream.lines(point.at, ZONE, label, boardName);
  const reply = await ask({
    system: coachSystem(name),
    user: coachPrompt({ goals, today: [], ...seen, at: point.at, timeZone: ZONE }),
  });
  const verdict = parseCoachReply(reply, goals);
  const said = verdict?.verdict === 'moment' ? 'speak' : 'quiet';
  const goalOk =
    said !== 'speak' || verdict?.verdict !== 'moment' || verdict.goalIndex === point.goalIndex;
  const ok = said === point.expect && goalOk;
  if (ok) right += 1;
  const time = new Date(point.at).toLocaleTimeString('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
  console.log(
    `  ${ok ? 'right' : 'WRONG'} ${time} expected ${point.expect}, got ${verdict ? said : 'unusable'} (${point.why})`,
  );
  if (verdict?.verdict === 'moment')
    console.log(`        goal ${verdict.goalIndex + 1}: ${verdict.line}`);
}
console.log(`  ${right} of ${LABELLED_POINTS.length} right`);

console.log('\n== the on-track day, through the whole loop');
const dir = mkdtempSync(join(tmpdir(), 'coach-eval-'));
try {
  let clock = DAY_START;
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => reading,
    label,
    boardName,
    workspaceOf,
    generate: ask,
    publish: () => {},
    now: () => clock,
    log: () => {},
  });
  const before = promptChars.length;
  for (const s of ON_TRACK_DAY) {
    clock = s.at;
    if ('here' in s) coach.here(s.here);
    else coach.activity(s.row);
    await coach.settled();
  }
  clock = DAY_END;
  const outcomes = store.judgements().map((j) => j.outcome);
  console.log(`  ${promptChars.length - before} calls; outcomes ${JSON.stringify(outcomes)}`);
  console.log(`  moments raised: ${store.moments().length} (zero is right)`);
  for (const m of store.moments()) console.log(`    ${m.line}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const mean = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length));
// Four characters a token is the usual English rate; Haiku 4.5 is $1 in, $5 out per MTok.
const inTok = promptChars.reduce((s, x) => s + x, 0) / 4;
const outTok = replyChars.reduce((s, x) => s + x, 0) / 4;
console.log(
  `\n${promptChars.length} calls; prompt chars mean ${mean(promptChars)}, max ${Math.max(...promptChars)}; reply chars mean ${mean(replyChars)}`,
);
console.log(`this run cost about $${((inTok * 1 + outTok * 5) / 1e6).toFixed(4)}`);
