/**
 * The boards the router eval speaks to. Two of them: Harborlight, where every
 * utterance is said, and Harborlight Ops, whose similar name and its own
 * "Tide table refresh" and crew rota are near misses the router must not
 * reach from Harborlight. Every name is invented.
 *
 * Built fresh for each case (`buildRouterFixture`), so a case that moves a
 * task cannot change what the next one sees. Docs are titles plus the open
 * review items on them, which is all the router reads of a doc.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskBodyDocId } from '../packages/server/src/task-projection.ts';
import { TaskStore } from '../packages/server/src/tasks.ts';
import type { VoiceThreadReviewItem } from '../packages/server/src/voice-prompt.ts';

export const LEAD = { id: 'agent-harborlight', name: 'Harborlight Lead', kind: 'agent' };
export const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

/** Task key → title, status and assignee on the Harborlight board. */
export const TASKS = {
  timetable: { title: 'Harborlight ferry timetable', status: 'todo' },
  ticketing: { title: 'Harborlight ferry ticketing', status: 'in-progress' },
  survey: { title: 'Riverbend berth survey', status: 'todo', assignee: 'Bob' },
  repairs: { title: 'Riverbend berth repairs', status: 'todo' },
  parking: { title: 'Saltmarsh parking signs', status: 'done' },
  tide: { title: 'Tide survey for the slipway', status: 'todo' },
  winter: { title: 'Draft the winter schedule', status: 'todo', link: 'winter-plan' },
} as const;
export type TaskKey = keyof typeof TASKS;

/** Doc id → title. The page kind is the corpus's label, not the router's. */
export const DOCS: Record<string, string> = {
  'winter-plan': 'Winter schedule plan',
  'berth-plan': 'Riverbend berth plan',
  'weekly-sync': 'Riverbend weekly sync notes',
  'booking-mock': 'Harborlight booking page mock',
  'signage-review': 'Saltmarsh signage review',
};

export const GOALS = { crossing: 'Open the second ferry crossing', wait: 'Cut ticket wait times' };
export type GoalKey = keyof typeof GOALS;

const item = (
  threadId: string,
  ask: string,
  options?: Array<{ id: string; label: string }>,
): VoiceThreadReviewItem => ({
  threadId,
  commentId: `${threadId}-ask`,
  answerable: true,
  ask,
  askedBy: 'Bob',
  ...(options ? { options } : {}),
});

/** Open review items by doc id; `task:tide` is the tide task's discussion. */
export const REVIEW_ITEMS: Record<string, VoiceThreadReviewItem[]> = {
  'winter-plan': [item('th-sailing', 'Should the 7am sailing stay on the winter timetable?')],
  'booking-mock': [
    item('th-header', 'Which header for the booking page?', [
      { id: 'opt-blue', label: 'Keep the blue header' },
      { id: 'opt-white', label: 'Use the white header' },
    ]),
  ],
  'signage-review': [
    item('th-sign', 'Is the Saltmarsh sign wording final?'),
    item('th-font', 'Which font for the signs?', [
      { id: 'opt-serif', label: 'Serif' },
      { id: 'opt-sans', label: 'Sans' },
    ]),
  ],
  'task:tide': [
    item('th-slip', 'North or south slipway for the survey?', [
      { id: 'opt-north', label: 'North slipway' },
      { id: 'opt-south', label: 'South slipway' },
    ]),
  ],
};

export interface RouterFixture {
  store: TaskStore;
  workspaceId: string;
  taskIds: Record<TaskKey, string>;
  goalIds: Record<GoalKey, string>;
  /** Open review items by REAL doc id (a task's discussion resolved). */
  reviewItems: Map<string, VoiceThreadReviewItem[]>;
  docTitle: (docId: string) => string | undefined;
}

export function buildRouterFixture(): RouterFixture {
  const store = new TaskStore({
    dataDir: mkdtempSync(join(tmpdir(), 'cw-router-eval-')),
    debounceMs: 1,
  });
  const ws = store.createWorkspace('Harborlight', { leadAgentId: LEAD.id });
  const goalIds = {} as Record<GoalKey, string>;
  for (const [key, title] of Object.entries(GOALS) as Array<[GoalKey, string]>) {
    const r = store.addGoal(ws.id, { title }, { actor: LEAD });
    if (!r.ok) throw new Error(`fixture: goal ${key} refused`);
    goalIds[key] = r.goal.id;
  }
  for (const docId of Object.keys(DOCS)) store.attachDoc(ws.id, docId);
  const taskIds = {} as Record<TaskKey, string>;
  for (const [key, t] of Object.entries(TASKS) as Array<[TaskKey, (typeof TASKS)[TaskKey]]>) {
    const r = store.createTask(ws.id, {
      title: t.title,
      ...('assignee' in t ? { assignee: t.assignee, assigneeKind: 'person' as const } : {}),
      ...('link' in t ? { links: [{ kind: 'doc' as const, docId: t.link }] } : {}),
      actor: LEAD,
    });
    if (!r.ok) throw new Error(`fixture: task ${key} refused (${r.error})`);
    taskIds[key] = r.task.id;
    if (r.task.status !== t.status) {
      store.transition(r.task.id, t.status, { actor: LEAD });
    }
  }
  // The near-miss board: a similar name, and things Harborlight does not have.
  const ops = store.createWorkspace('Harborlight Ops', { leadAgentId: LEAD.id });
  store.createTask(ops.id, { title: 'Tide table refresh', actor: LEAD });
  store.attachDoc(ops.id, 'ops-rota');

  const reviewItems = new Map<string, VoiceThreadReviewItem[]>();
  for (const [key, items] of Object.entries(REVIEW_ITEMS)) {
    const docId = key.startsWith('task:') ? taskBodyDocId(taskIds[key.slice(5) as TaskKey]) : key;
    reviewItems.set(docId, items);
  }
  const titles: Record<string, string> = { ...DOCS, 'ops-rota': 'Harborlight crew rota' };
  return {
    store,
    workspaceId: ws.id,
    taskIds,
    goalIds,
    reviewItems,
    docTitle: (docId) => titles[docId],
  };
}
