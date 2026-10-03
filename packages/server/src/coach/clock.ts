/**
 * The coach's calendar: which week and day an instant falls on in Bryan's
 * time zone, and whether a check is due.
 *
 * The cadence is the design note's default: every 3 hours from 9am to 9pm
 * local, so at most four checks land in a day. A check is due when the
 * local hour is inside that span and the last check is at least the
 * interval old. Pure, so the tests drive it with fixed instants.
 */
import { instantForLocal, zonedParts } from '@claude-workspaces/core/schedule-timezone';

export const CHECK_INTERVAL_MS = 3 * 60 * 60_000;
/** The first local hour a check may run in, and the hour checks stop. */
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 21;

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

/** The Monday of the local week `instant` falls in, `YYYY-MM-DD`. */
export function weekOf(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  // Day-of-week from the calendar date alone, so the zone cannot shift it.
  const civil = Date.UTC(p.year, p.month - 1, p.day);
  const dow = (new Date(civil).getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(civil - dow * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

/** Is a check due at `now`, given when the last one ran? */
export function checkDue(now: number, lastCheckAt: number | undefined, timeZone: string): boolean {
  const hour = zonedParts(now, timeZone).hour;
  if (hour < DAY_START_HOUR || hour >= DAY_END_HOUR) return false;
  return lastCheckAt === undefined || now - lastCheckAt >= CHECK_INTERVAL_MS;
}
