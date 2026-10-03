/**
 * The coach's calendar: which local day an instant falls on in Bryan's time
 * zone, and when it is next allowed to speak.
 *
 * Pure, so the tests drive it with fixed instants.
 */
import { instantForLocal, zonedParts } from '@claude-workspaces/core/schedule-timezone';
import { type CoachMoment, type CoachSpacing, MAX_MOMENTS_PER_DAY, SPACING_MS } from './types.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for the local day `instant` falls on. */
export function localDay(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The instant the local day containing `instant` began. */
export function startOfLocalDay(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return instantForLocal(timeZone, p.year, p.month, p.day, 0, 0);
}

/**
 * May a moment be raised at `now`? The gap after the last moment is his
 * setting, doubled for each "Not now" he gave today, and the day holds at
 * most `MAX_MOMENTS_PER_DAY` whatever the setting.
 */
export function spacingAllows(
  now: number,
  moments: readonly CoachMoment[],
  spacing: CoachSpacing,
  timeZone: string,
): boolean {
  const today = localDay(now, timeZone);
  const todays = moments.filter((m) => m.day === today);
  if (todays.length >= MAX_MOMENTS_PER_DAY) return false;
  const last = moments.at(-1);
  if (!last) return true;
  const notNows = todays.filter((m) => m.state === 'not-now').length;
  return now - last.at >= SPACING_MS[spacing] * 2 ** notNows;
}
