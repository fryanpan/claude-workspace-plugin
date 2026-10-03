/**
 * The coach's loop: signals in, a moment out, rarely.
 *
 * Each signal goes to the stream (`coach/stream.ts`), whose free trigger
 * says when something changed enough to look. A candidate is judged only
 * when every gate that can decline has passed, so a model call is spent only
 * when there is a goal to act on, no moment is waiting, his spacing allows
 * one, the last judgement is at least `MIN_JUDGE_GAP_MS` old and no other
 * judgement is in flight. Each judgement leaves one record
 * (`CoachJudgement`), which is what the wrong-call figures are counted from.
 *
 * The judge is reached through one seam, `generate`. In the real server it
 * is the coach's Claude Code session (`coach/session-judge.ts`); a test
 * hands in a stand-in, so no test reaches a model.
 */
import type { Event } from '../activity.ts';
import { spacingAllows } from './clock.ts';
import type { DocLabel } from './digest.ts';
import { type GoalsDocReading, actionableGoals, goalTitle } from './goals-doc.ts';
import { coachPrompt, coachSystem, parseCoachReply } from './judge.ts';
import type { CoachStore } from './store.ts';
import type { CoachStream, HereSignal } from './stream.ts';
import type { CoachJudgement, CoachMoment, JudgementOutcome, MomentAnswer } from './types.ts';

/** At most one judgement in this window: a session turn each, so a day of
 *  ten active hours asks at most 60. */
export const MIN_JUDGE_GAP_MS = 10 * 60_000;
export const DEFAULT_COACH_NAME = 'Your coach';

export type CoachGenerator = (prompt: { system: string; user: string }) => Promise<string | null>;

/** What a page is told. */
export type CoachFrame =
  | { type: 'moment'; moment: { id: string; at: number; name: string; line: string; goal: string } }
  | { type: 'clear'; id: string };

export interface CoachDeps {
  store: CoachStore;
  stream: CoachStream;
  /** The goals doc as it reads now, or null when there is none. */
  readGoals: () => GoalsDocReading | null;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** Null when there is no judge at all. */
  generate: CoachGenerator | null;
  /** False when the judge cannot be asked now (no session attached). */
  reachable?: () => boolean;
  publish: (frame: CoachFrame) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Coach {
  here(signal: Omit<HereSignal, 'at'>): void;
  activity(row: Event): void;
  /** Judge now, whatever the trigger says; every other gate still holds. */
  judgeNow(): Promise<CoachJudgement | { skipped: string }>;
  answer(id: string, answer: MomentAnswer): boolean;
  /** The open moment as a page shows it, if any. */
  openFrame(): CoachFrame | null;
  /** Resolves when the judgement in flight, if any, has landed. */
  settled(): Promise<void>;
}

export function createCoach(deps: CoachDeps): Coach {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  let inflight: Promise<CoachJudgement | { skipped: string }> | null = null;

  const name = (reading: GoalsDocReading | null) => reading?.name ?? DEFAULT_COACH_NAME;

  const frameOf = (m: CoachMoment, reading: GoalsDocReading | null): CoachFrame => ({
    type: 'moment',
    moment: { id: m.id, at: m.at, name: name(reading), line: m.line, goal: m.goal },
  });

  const lastJudgedAt = () => deps.store.judgements().at(-1)?.at;

  /** Every gate, in order; the first that declines names itself. */
  const blocked = (t: number, reading: GoalsDocReading | null): string | null => {
    if (!reading || actionableGoals(reading).length === 0) return 'no-goals';
    if (deps.store.openMoment(t)) return 'moment-open';
    if (!spacingAllows(t, deps.store.moments(), deps.store.spacing, deps.store.timeZone)) {
      return 'spacing';
    }
    const last = lastJudgedAt();
    if (last !== undefined && t - last < MIN_JUDGE_GAP_MS) return 'judged-recently';
    return null;
  };

  const run = async (
    cause: CoachJudgement['cause'],
  ): Promise<CoachJudgement | { skipped: string }> => {
    const t = now();
    const reading = deps.readGoals();
    const why = blocked(t, reading);
    if (why) return { skipped: why };
    const goals = actionableGoals(reading as GoalsDocReading);
    const record = (outcome: JudgementOutcome): CoachJudgement => {
      const rec = { at: t, outcome, cause };
      deps.store.recordJudgement(rec);
      log(`[coach] judged (${cause}): ${outcome}`);
      return rec;
    };
    if (!deps.generate || deps.reachable?.() === false) return record('no-session');
    const tz = deps.store.timeZone;
    const seen = deps.stream.lines(t, tz, deps.label, deps.boardName);
    const reply = await deps
      .generate({
        system: coachSystem(name(reading)),
        user: coachPrompt({
          goals,
          today: deps.store.momentsToday(t),
          ...seen,
          at: t,
          timeZone: tz,
        }),
      })
      .catch(() => null);
    if (reply === null) return record('no-answer');
    const verdict = parseCoachReply(reply, goals);
    if (!verdict) return record('unusable-reply');
    if (verdict.verdict === 'quiet') return record('quiet');
    const goal = goals[verdict.goalIndex];
    const m = deps.store.addMoment({
      at: t,
      goalIndex: verdict.goalIndex,
      goal: goal ? goalTitle(goal) : '',
      matched: verdict.matched,
      observed: verdict.observed,
      line: verdict.line,
    });
    deps.publish(frameOf(m, reading));
    return record('moment');
  };

  const judge = (cause: CoachJudgement['cause']) => {
    if (inflight) return inflight;
    inflight = run(cause).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const onTrigger = (cause: string | null) => {
    if (!cause) return;
    void judge('trigger').catch((err) => log(`[coach] judgement failed: ${String(err)}`));
  };

  return {
    here(signal) {
      onTrigger(deps.stream.here({ ...signal, at: now() }));
    },
    activity(row) {
      if (!row.isOwner) return;
      const goalsDoc = deps.store.goalsDoc;
      if (goalsDoc && row.type === 'edit_session' && row.doc?.docId === goalsDoc.docId) {
        deps.store.noteGoalsChanged(now());
      }
      onTrigger(deps.stream.activity(row, now(), deps.workspaceOf));
    },
    judgeNow: () => judge('asked'),
    answer(id, answer) {
      if (!deps.store.answer(id, answer, now())) return false;
      deps.publish({ type: 'clear', id });
      return true;
    },
    openFrame() {
      const m = deps.store.openMoment(now());
      return m ? frameOf(m, deps.readGoals()) : null;
    },
    async settled() {
      await inflight?.catch(() => undefined);
    },
  };
}
