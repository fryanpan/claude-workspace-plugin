/**
 * The coach's check: every few hours, read Bryan's day, ask the model once,
 * and raise at most one nudge.
 *
 * Every gate that can decline is checked before the model is asked, so a
 * check costs a call only when there are goals, no nudge is waiting, the
 * day's cap is not reached and something new happened since the last call.
 * Each check leaves one record (`CoachPassRecord`) naming what it did.
 *
 * The model is reached through the summarizer's seam (`generate` below is
 * `ThreadSummarizer.generateHomeBrief` in the real server), so a test or a
 * staging server without a key can never call the API.
 */
import { checkDue, startOfLocalDay } from './clock.ts';
import { type DocLabel, digestActivity, digestLines } from './digest.ts';
import { COACH_SYSTEM, coachPrompt, parseCoachReply } from './judge.ts';
import type { CoachStore } from './store.ts';
import { type CoachPassRecord, MAX_NUDGES_PER_DAY, type PassOutcome } from './types.ts';

/** How often the loop asks whether a check is due. */
export const TICK_MS = 15 * 60_000;

/** The outcomes that spent a model call. */
const CALLED: ReadonlySet<PassOutcome> = new Set(['nudged', 'on-track', 'unusable-reply']);

export type CoachGenerator = (prompt: { system: string; user: string }) => Promise<string | null>;

export interface CoachDeps {
  store: CoachStore;
  /** The activity rows to read, newest at the end (`readJsonlTail`). */
  readRows: () => unknown[];
  label: (docId: string) => DocLabel;
  /** Null when this server has no model key. */
  generate: CoachGenerator | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Coach {
  /** Run a check now, whatever the clock says. */
  check(): Promise<CoachPassRecord>;
  /** Run a check if one is due. Never throws. */
  tick(): Promise<CoachPassRecord | null>;
  start(): void;
  stop(): void;
}

export function createCoach(deps: CoachDeps): Coach {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  let inflight: Promise<CoachPassRecord> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const lastCallAt = (): number | undefined => {
    const passes = deps.store.passes();
    for (let i = passes.length - 1; i >= 0; i -= 1) {
      const p = passes[i];
      if (p && CALLED.has(p.outcome)) return p.at;
    }
    return undefined;
  };

  async function run(): Promise<CoachPassRecord> {
    const t = now();
    const { store } = deps;
    const done = (outcome: PassOutcome, lines = 0): CoachPassRecord => {
      const rec = { at: t, outcome, lines };
      store.recordPass(rec);
      log(`[coach] check: ${outcome} (${lines} lines)`);
      return rec;
    };
    const list = store.currentGoals(t);
    if (!list || list.goals.length === 0) return done('no-goals');
    if (store.openNudge(t)) return done('nudge-open');
    const today = store.nudgesToday(t);
    if (today.length >= MAX_NUDGES_PER_DAY) return done('daily-cap');
    const docs = digestActivity(deps.readRows(), startOfLocalDay(t, store.timeZone), deps.label);
    const since = lastCallAt();
    if (docs.length === 0 || (since !== undefined && !docs.some((d) => d.lastAt > since))) {
      return done('no-new-activity', docs.length);
    }
    if (!deps.generate) return done('no-model', docs.length);
    const user = coachPrompt({
      goals: list.goals,
      today,
      lines: digestLines(docs, store.timeZone),
      now: t,
      timeZone: store.timeZone,
    });
    const verdict = parseCoachReply(
      await deps.generate({ system: COACH_SYSTEM, user }),
      list.goals.length,
    );
    if (!verdict) return done('unusable-reply', docs.length);
    if (verdict.verdict === 'on-track') return done('on-track', docs.length);
    store.addNudge({
      at: t,
      goalIndex: verdict.goalIndex,
      goal: list.goals[verdict.goalIndex] ?? '',
      drift: verdict.drift,
      question: verdict.question,
    });
    return done('nudged', docs.length);
  }

  const check = (): Promise<CoachPassRecord> => {
    // Two triggers at once (the loop and the route) share one check.
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const coach: Coach = {
    check,
    async tick() {
      try {
        if (!checkDue(now(), deps.store.lastPass()?.at, deps.store.timeZone)) return null;
        return await check();
      } catch (err) {
        log(`[coach] check failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void coach.tick(), TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return coach;
}
