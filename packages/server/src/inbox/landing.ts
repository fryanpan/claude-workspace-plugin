/**
 * Incoming Messages for one front-page load: the rows, ranked against the
 * project order the page shows, drawn with their styles.
 *
 * The caller asks only for Bryan's own signed-in session (a person proof
 * naming the owner), so the lines never reach an agent fetching `/` from
 * this machine, a share visitor, or a member's list of their boards.
 */
import type { TaskStore } from '../tasks.ts';
import type { InboxConfig } from './config.ts';
import { INBOX_SECTION_CSS } from './section-css.ts';
import { renderInboxSection } from './section.ts';
import type { InboxStore } from './store.ts';
import type { InboxGoalRef } from './types.ts';

export interface InboxLandingDeps {
  store: InboxStore;
  config: InboxConfig;
  taskStore: Pick<TaskStore, 'getWorkspace'>;
  /** Board id → 1-based project rank, as the page's own project list. */
  rankOf: ReadonlyMap<string, number>;
  now?: number;
}

/** The section's HTML with its stylesheet, or '' when there is no inbox. */
export function inboxSectionFor(deps: InboxLandingDeps): string {
  const goals = (ref: InboxGoalRef) => deps.taskStore.getWorkspace(ref.workspaceId)?.goals ?? [];
  const html = renderInboxSection({
    rows: deps.store.list(),
    config: deps.config,
    projectRank: (ws) => deps.rankOf.get(ws),
    goalIndex: (ref) => {
      const i = goals(ref).findIndex((g) => g.id === ref.goalId);
      return i < 0 ? undefined : i;
    },
    goalTitle: (ref) => goals(ref).find((g) => g.id === ref.goalId)?.title,
    lastPassAt: deps.store.lastPass()?.at,
    now: deps.now ?? Date.now(),
  });
  return html === '' ? '' : `<style>${INBOX_SECTION_CSS}</style>\n${html}`;
}
