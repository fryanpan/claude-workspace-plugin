/**
 * The coach's one file, `<dataDir>/coach/state.json`: the goal lists, the
 * nudges and the record of each check. Owner-only on disk (mode 600), and
 * written whole through a temp file, like the inbox's files.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isKnownTimezone } from '@claude-workspaces/core/schedule-timezone';
import { readJsonFile, writeJsonFile } from '../inbox/json-file.ts';
import { localDay, weekOf } from './clock.ts';
import {
  type CoachGoalList,
  type CoachNudge,
  type CoachPassRecord,
  type CoachState,
  MAX_GOALS,
  MAX_GOAL_CHARS,
  MAX_PASS_RECORDS,
  type NudgeAnswer,
} from './types.ts';

export const COACH_DIRNAME = 'coach';
/** Before Bryan saves goals from a browser, the zone this machine is in. */
const DEFAULT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const empty = (): CoachState => ({ timeZone: DEFAULT_ZONE, lists: [], nudges: [], passes: [] });

/** The goals as typed, cleaned to at most three single lines, or the reason
 *  they cannot be saved. Blank lines are dropped, not counted. */
export function cleanGoals(raw: unknown): { goals: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'goals must be a list' };
  if (raw.some((g) => typeof g !== 'string')) return { error: 'every goal must be text' };
  const goals = (raw as string[]).map((g) => g.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (goals.length > MAX_GOALS) return { error: `at most ${MAX_GOALS} goals` };
  if (goals.some((g) => g.length > MAX_GOAL_CHARS)) {
    return { error: `a goal is at most ${MAX_GOAL_CHARS} characters` };
  }
  return { goals };
}

export class CoachStore {
  private readonly path: string;
  private state: CoachState;

  constructor(dataDir: string, now: number = Date.now()) {
    this.path = join(dataDir, COACH_DIRNAME, 'state.json');
    const { value, error } = readJsonFile<CoachState>(this.path, empty(), now);
    if (error) console.warn(`[coach] state unreadable: ${error}; starting empty`);
    this.state = { ...empty(), ...value };
    if (!isKnownTimezone(this.state.timeZone)) this.state.timeZone = DEFAULT_ZONE;
  }

  get timeZone(): string {
    return this.state.timeZone;
  }

  /** This week's goals, or null when none have been set for it. */
  currentGoals(now: number): CoachGoalList | null {
    const week = weekOf(now, this.state.timeZone);
    for (let i = this.state.lists.length - 1; i >= 0; i -= 1) {
      const list = this.state.lists[i];
      if (list?.week === week) return list;
    }
    return null;
  }

  /** Replace this week's goals. The old list stays in the file. */
  setGoals(goals: string[], timeZone: string | undefined, now: number): CoachGoalList {
    if (timeZone && isKnownTimezone(timeZone)) this.state.timeZone = timeZone;
    const list = { week: weekOf(now, this.state.timeZone), goals, setAt: now };
    this.state.lists.push(list);
    this.write();
    return list;
  }

  /** The nudge on the page, after retiring any from an earlier day. */
  openNudge(now: number): CoachNudge | null {
    this.expireOld(now);
    return this.state.nudges.find((n) => n.state === 'open') ?? null;
  }

  /** Nudges raised on the local day `now` falls on, any state. */
  nudgesToday(now: number): CoachNudge[] {
    const day = localDay(now, this.state.timeZone);
    return this.state.nudges.filter((n) => n.day === day);
  }

  addNudge(n: Omit<CoachNudge, 'id' | 'day' | 'state'>): CoachNudge {
    const nudge: CoachNudge = {
      ...n,
      id: `cn-${randomBytes(9).toString('base64url').slice(0, 12)}`,
      day: localDay(n.at, this.state.timeZone),
      state: 'open',
    };
    this.state.nudges.push(nudge);
    this.write();
    return nudge;
  }

  /** Bryan's answer. False when there is no such open nudge. */
  answer(id: string, answer: NudgeAnswer, now: number): boolean {
    const n = this.state.nudges.find((x) => x.id === id);
    if (!n || n.state !== 'open') return false;
    n.state = answer;
    n.answeredAt = now;
    this.write();
    return true;
  }

  passes(): readonly CoachPassRecord[] {
    return this.state.passes;
  }

  lastPass(): CoachPassRecord | undefined {
    return this.state.passes.at(-1);
  }

  recordPass(rec: CoachPassRecord): void {
    this.state.passes.push(rec);
    if (this.state.passes.length > MAX_PASS_RECORDS) {
      this.state.passes.splice(0, this.state.passes.length - MAX_PASS_RECORDS);
    }
    this.write();
  }

  private expireOld(now: number): void {
    const today = localDay(now, this.state.timeZone);
    let changed = false;
    for (const n of this.state.nudges) {
      if (n.state === 'open' && n.day !== today) {
        n.state = 'expired';
        changed = true;
      }
    }
    if (changed) this.write();
  }

  private write(): void {
    writeJsonFile(this.path, this.state);
  }
}
