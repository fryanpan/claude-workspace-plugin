/**
 * "Your coach" for one front-page load, drawn with its styles. Asked only
 * for the owner's own signed-in session.
 */
import { actionableGoals, goalTitle } from './goals-doc.ts';
import type { GoalsDocReading } from './goals-doc.ts';
import { DEFAULT_COACH_NAME } from './moment.ts';
import { COACH_SECTION_CSS, renderCoachSection } from './section.ts';
import type { CoachStore } from './store.ts';

export interface CoachSectionState {
  /** A coach session is listening. */
  online: boolean;
  /** The day's event budget is spent. */
  paused: boolean;
  boardName: (workspaceId: string) => string | undefined;
}

export function coachSectionFor(
  store: CoachStore,
  readGoals: () => GoalsDocReading | null,
  state: CoachSectionState,
  now: number = Date.now(),
): string {
  const doc = store.goalsDoc;
  const reading = doc ? readGoals() : null;
  const goals = reading?.goals ?? [];
  const html = renderCoachSection({
    docUrl: doc
      ? `/workspaces/${encodeURIComponent(doc.workspaceId)}/docs/${encodeURIComponent(doc.docId)}`
      : null,
    name: reading?.name ?? DEFAULT_COACH_NAME,
    online: state.online,
    goals: goals.map(goalTitle),
    unready: reading ? goals.length - actionableGoals(reading).length : 0,
    reviewDue: store.reviewDue(now),
    readiness: store.readiness,
    week: store.week(now),
    paused: state.paused,
    // A board since deleted has no name and is left out.
    offBoards: [...store.offBoards].flatMap((id) => {
      const name = state.boardName(id);
      return name ? [{ id, name }] : [];
    }),
  });
  return `<style>${COACH_SECTION_CSS}</style>\n${html}`;
}
