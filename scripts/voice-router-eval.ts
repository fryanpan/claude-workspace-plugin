#!/usr/bin/env bun
/**
 * Does voice do what Alice asked, on the page she asked it from?
 *
 * Runs every case in `voice-router-corpus.ts` through the real `VoiceRouter`
 * over the invented boards in `voice-router-fixture.ts`, and reports whether
 * the right thing happened (the right page opened, the right task moved, her
 * words landed in the right place, or the request went to the lead agent),
 * by page kind, with latency by path and the misses grouped by kind of miss.
 *
 *   bun run scripts/voice-router-eval.ts [--router json|choice|jev|none] [--runs 1]
 *     [--out results.json] [--budget 1.5] [--verbose]
 *
 * `--router` picks the classifier behind the server's own rules:
 *   json    the current router: Haiku 4.5 returns a JSON classification
 *   choice  one choice question over the routes plus "none" (Haiku 4.5)
 *   jev     the same question asked of TypeSafe's Jev. REFUSED: sending
 *           workspace text there waits on the owner's decision
 *   none    no model at all; what the server's rules decide alone
 *
 * The paid arms spend the EVAL credential only (`eval-credential.ts`), on
 * fixture text only, and stop when the run's spend reaches `--budget`
 * dollars. One run of 72 cases costs about five cents.
 */
import { writeFileSync } from 'node:fs';
import { type TokenUsage, dollars } from '../packages/core/src/model-cost.ts';
import { withoutProdMarker } from '../packages/server/src/claude-key-source.ts';
import { haikuChoiceClassifier } from '../packages/server/src/voice-choice.ts';
import { type VoiceClassifier, jsonClassifier } from '../packages/server/src/voice-classifier.ts';
import { haikuVoiceComplete } from '../packages/server/src/voice.ts';
import { EVAL_CREDENTIAL_HELP } from './eval-credential.ts';
import { ROUTER_CORPUS, isQuickCase } from './voice-router-corpus.ts';
import {
  type Scored,
  accuracyByKind,
  confidenceSeparation,
  latencyByPath,
  misrouteClasses,
} from './voice-router-report.ts';
import { describeOutcome, runCase, scored } from './voice-router-run.ts';

const MODEL = 'claude-haiku-4-5-20251001';
const ROUTERS = ['json', 'choice', 'jev', 'none'] as const;
type Router = (typeof ROUTERS)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const router = (arg('router') ?? 'json') as Router;
if (!ROUTERS.includes(router)) {
  console.error(`--router must be one of ${ROUTERS.join(', ')}`);
  process.exit(2);
}
if (router === 'jev') {
  console.error(
    'The jev arm is blocked on the owner’s data decision: it would send workspace text to ' +
      'TypeSafe, and that is not approved. Its request and parsing are unit-tested ' +
      '(packages/server/test/voice-jev.test.ts); nothing here calls it.',
  );
  process.exit(3);
}
const runs = Number(arg('runs')) || 1;
const budget = Number(arg('budget')) || 1.5;
const out = arg('out');
const verbose = process.argv.includes('--verbose');

let usd = 0;
let calls = 0;
/** Prices each reply off its own `usage`, and reads nothing else of it. */
const meteredFetch: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (usd >= budget) throw new Error(`budget of $${budget} reached`);
    const res = await fetch(input, init);
    calls++;
    try {
      const body = (await res.clone().json()) as { usage?: Record<string, number> };
      const u = body.usage ?? {};
      const usage: TokenUsage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      usd += dollars(usage, MODEL);
    } catch {
      // An unreadable body is still a call; the router reports its failure.
    }
    return res;
  },
  { preconnect: fetch.preconnect },
);

let classify: VoiceClassifier | undefined;
if (router !== 'none') {
  const complete = haikuVoiceComplete({
    env: withoutProdMarker(process.env),
    fetchImpl: meteredFetch,
  });
  if (!complete) {
    console.error(EVAL_CREDENTIAL_HELP);
    process.exit(2);
  }
  classify = router === 'json' ? jsonClassifier(complete) : haikuChoiceClassifier(complete);
}

const rows: Scored[] = [];
for (let r = 0; r < runs; r++) {
  for (const c of ROUTER_CORPUS) {
    const run = await runCase(c, classify);
    const right = scored(c, run.observed);
    rows.push({ case: c, run, right });
    if (verbose || !right) {
      const conf = run.confidence !== undefined ? ` @${run.confidence.toFixed(2)}` : '';
      console.log(
        `${right ? 'ok  ' : 'MISS'} ${c.kind.padEnd(11)} ${run.path.padEnd(6)} ` +
          `"${c.said}" → ${describeOutcome(run.observed)}${conf}`,
      );
    }
  }
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
const ms = (v: number | undefined): string => (v === undefined ? '-' : `${v.toFixed(0)}ms`);

console.log(`\nrouter ${router}; ${ROUTER_CORPUS.length} cases × ${runs} run(s)`);
console.log('\n| page kind | right | of | accuracy |\n|---|---|---|---|');
for (const k of accuracyByKind(rows)) {
  console.log(`| ${k.kind} | ${k.right} | ${k.total} | ${pct(k.right, k.total)} |`);
}
const quickRows = rows.filter((r) => isQuickCase(r.case));
const quickRight = quickRows.filter((r) => r.right).length;
console.log(
  `\nquick actions (open, go, start, feedback, help): ${quickRight} of ${quickRows.length} ` +
    `(${pct(quickRight, quickRows.length)})`,
);
console.log(
  '\n| path | cases | median | p90 | model asked | model median |\n|---|---|---|---|---|---|',
);
for (const p of latencyByPath(rows)) {
  console.log(
    `| ${p.path} | ${p.n} | ${ms(p.medianMs)} | ${ms(p.p90Ms)} | ${p.asked} | ${ms(p.classifierMedianMs)} |`,
  );
}
console.log('\nmisroute classes, most frequent first:');
for (const m of misrouteClasses(rows)) {
  console.log(`  ${m.count}  ${m.label}\n       ${m.examples.join('\n       ')}`);
}
const sep = confidenceSeparation(rows);
if (sep.n > 0) {
  console.log(
    `\nconfidence on ${sep.n} model answers: AUROC ${sep.auc?.toFixed(2) ?? '-'}; ` +
      `${sep.wrongAtHigh} wrong of ${sep.high} at ≥0.90`,
  );
}
console.log(`\nspend: $${usd.toFixed(4)} over ${calls} call(s) on the eval credential`);

if (out) {
  writeFileSync(
    out,
    JSON.stringify(
      {
        router,
        runs,
        usd,
        calls,
        byKind: accuracyByKind(rows),
        quick: { right: quickRight, total: quickRows.length },
        byPath: latencyByPath(rows),
        classes: misrouteClasses(rows),
        separation: sep,
        cases: rows.map((r) => ({
          kind: r.case.kind,
          said: r.case.said,
          right: r.right,
          path: r.run.path,
          observed: describeOutcome(r.run.observed),
          ...(r.run.confidence !== undefined ? { confidence: r.run.confidence } : {}),
        })),
      },
      null,
      2,
    ),
  );
}
