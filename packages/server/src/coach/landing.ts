/**
 * "This week" for one front-page load: the week's goals and the open nudge,
 * drawn with their styles. Asked only for Bryan's own signed-in session.
 */
import { COACH_SECTION_CSS, renderCoachSection } from './section.ts';
import type { CoachStore } from './store.ts';

export function coachSectionFor(store: CoachStore, now: number = Date.now()): string {
  const html = renderCoachSection({
    goals: store.currentGoals(now),
    nudge: store.openNudge(now),
    lastPass: store.lastPass(),
  });
  return `<style>${COACH_SECTION_CSS}</style>\n${html}`;
}
