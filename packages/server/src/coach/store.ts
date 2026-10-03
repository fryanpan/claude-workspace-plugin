/**
 * The coach's one file, `<dataDir>/coach/state.json`: where the goals doc
 * is, his how-often setting, the moments and the record of each judgement.
 * Owner-only on disk (mode 600), and written whole through a temp file, like
 * the inbox's files.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isKnownTimezone } from '@claude-workspaces/core/schedule-timezone';
import { readJsonFile, writeJsonFile } from '../inbox/json-file.ts';
import { localDay } from './clock.ts';
import {
  COACH_SPACINGS,
  type CoachGoalsDoc,
  type CoachJudgement,
  type CoachMoment,
  type CoachSpacing,
  type CoachState,
  MAX_JUDGEMENTS,
  MOMENT_TTL_MS,
  type MomentAnswer,
  REVIEW_AFTER_MS,
} from './types.ts';

export const COACH_DIRNAME = 'coach';
/** Until a browser says otherwise, the zone this machine is in. */
const DEFAULT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const empty = (): CoachState => ({
  timeZone: DEFAULT_ZONE,
  spacing: 'normal',
  moments: [],
  judgements: [],
});

/** One week's answers, for the front page's line and the wrong-call rate. */
export interface CoachWeek {
  moments: number;
  thanks: number;
  notNow: number;
  notThis: number;
  unanswered: number;
  judgements: number;
  quiet: number;
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
    if (!COACH_SPACINGS.includes(this.state.spacing)) this.state.spacing = 'normal';
  }

  get timeZone(): string {
    return this.state.timeZone;
  }

  get spacing(): CoachSpacing {
    return this.state.spacing;
  }

  get goalsDoc(): CoachGoalsDoc | undefined {
    return this.state.goalsDoc;
  }

  noteTimeZone(timeZone: unknown): void {
    if (typeof timeZone !== 'string' || timeZone === this.state.timeZone) return;
    if (!isKnownTimezone(timeZone)) return;
    this.state.timeZone = timeZone;
    this.write();
  }

  setGoalsDoc(doc: CoachGoalsDoc): void {
    this.state.goalsDoc = doc;
    this.state.goalsChangedAt = doc.createdAt;
    this.write();
  }

  setSpacing(spacing: CoachSpacing): void {
    this.state.spacing = spacing;
    this.write();
  }

  /** He edited the goals doc. Written at most once a minute. */
  noteGoalsChanged(at: number): void {
    const last = this.state.goalsChangedAt ?? 0;
    if (at - last < 60_000) return;
    this.state.goalsChangedAt = at;
    this.write();
  }

  declineReview(now: number): void {
    this.state.reviewDeclinedAt = now;
    this.write();
  }

  /** Is the weekly offer to review the goals due? Seven days after the
   *  later of his last change and his last "no update needed". */
  reviewDue(now: number): boolean {
    if (!this.state.goalsDoc) return false;
    const since = Math.max(this.state.goalsChangedAt ?? 0, this.state.reviewDeclinedAt ?? 0);
    return now - since >= REVIEW_AFTER_MS;
  }

  moments(): readonly CoachMoment[] {
    return this.state.moments;
  }

  /** The moment on the page, after closing any he left past its time. */
  openMoment(now: number): CoachMoment | null {
    let changed = false;
    for (const m of this.state.moments) {
      if (m.state === 'open' && now - m.at >= MOMENT_TTL_MS) {
        m.state = 'expired';
        changed = true;
      }
    }
    if (changed) this.write();
    return this.state.moments.find((m) => m.state === 'open') ?? null;
  }

  /** Moments raised on the local day `now` falls on, any state. */
  momentsToday(now: number): CoachMoment[] {
    const day = localDay(now, this.state.timeZone);
    return this.state.moments.filter((m) => m.day === day);
  }

  addMoment(m: Omit<CoachMoment, 'id' | 'day' | 'state'>): CoachMoment {
    const moment: CoachMoment = {
      ...m,
      id: `cm-${randomBytes(9).toString('base64url').slice(0, 12)}`,
      day: localDay(m.at, this.state.timeZone),
      state: 'open',
    };
    this.state.moments.push(moment);
    this.write();
    return moment;
  }

  /** His answer. False when there is no such open moment. */
  answer(id: string, answer: MomentAnswer, now: number): boolean {
    const m = this.state.moments.find((x) => x.id === id);
    if (!m || m.state !== 'open') return false;
    m.state = answer;
    m.answeredAt = now;
    this.write();
    return true;
  }

  judgements(): readonly CoachJudgement[] {
    return this.state.judgements;
  }

  recordJudgement(rec: CoachJudgement): void {
    this.state.judgements.push(rec);
    if (this.state.judgements.length > MAX_JUDGEMENTS) {
      this.state.judgements.splice(0, this.state.judgements.length - MAX_JUDGEMENTS);
    }
    this.write();
  }

  /** The seven days before `now`. */
  week(now: number): CoachWeek {
    const since = now - 7 * 24 * 60 * 60_000;
    const moments = this.state.moments.filter((m) => m.at >= since);
    const judged = this.state.judgements.filter((j) => j.at >= since);
    const count = (s: CoachMoment['state']) => moments.filter((m) => m.state === s).length;
    return {
      moments: moments.length,
      thanks: count('thanks'),
      notNow: count('not-now'),
      notThis: count('not-this'),
      unanswered: count('expired'),
      judgements: judged.length,
      quiet: judged.filter((j) => j.outcome === 'quiet').length,
    };
  }

  private write(): void {
    writeJsonFile(this.path, this.state);
  }
}
