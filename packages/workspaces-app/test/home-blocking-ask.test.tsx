/**
 * An ask that STOPS work, on Home: the board's order (the lead's rank) still
 * places it, it leads only among asks with the same place, and its row
 * carries one steady line naming what is stopped and the goal that work
 * serves. Every other row is unchanged. Fixtures are invented.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../src/board/board-model.ts';
import { type ReviewThreadItem, reviewQueue } from '../src/board/board-review-model.ts';
import { homeReviewData, mountHomeReviewIsland } from '../src/board/home-review-island.tsx';

const NOW = 1_700_000_000_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

function task(id: string, order: number): BoardTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'in-progress',
    goal: 'chores',
    order,
    createdAt: NOW - 86_400_000,
    after: [],
  } as unknown as BoardTask;
}

function ask(
  taskId: string,
  headline: string,
  blocks?: { what: string; goalId?: string },
): ReviewThreadItem {
  return {
    kind: 'task-thread',
    band: 'declared',
    docId: `task:${taskId}`,
    threadId: `th-${taskId}-${headline.length}`,
    commentId: `c-${taskId}-${headline.length}`,
    taskId,
    title: `Task ${taskId}`,
    ask: headline,
    askedBy: 'Harborlight Bench',
    since: NOW - 3_600_000,
    direct: true,
    review: { shape: 'review', headline, ...(blocks ? { blocks } : {}) },
  } as ReviewThreadItem;
}

describe('a blocking ask on Home', () => {
  it('stays below an ask on a higher-ranked task', () => {
    const tasks = [task('t-riverbend', 1), task('t-saltmarsh', 2)];
    const q = reviewQueue(
      tasks,
      [
        ask('t-saltmarsh', 'Which Saltmarsh date counts?', { what: 'the Saltmarsh re-run' }),
        ask('t-riverbend', 'Does the Riverbend chart read right?'),
      ],
      NOW,
    );
    expect(q.items.map((i) => i.ask)).toEqual([
      'Does the Riverbend chart read right?',
      'Which Saltmarsh date counts?',
    ]);
  });

  it('leads the asks that share its place: its own task, and the asks no task places', () => {
    const doc = (headline: string, blocks?: { what: string }): ReviewThreadItem =>
      ({
        ...ask('t-none', headline, blocks),
        kind: 'doc-thread',
        docId: 'd-dock',
        taskId: undefined,
        since: NOW - 7_200_000,
      }) as ReviewThreadItem;
    const q = reviewQueue(
      [task('t-riverbend', 1)],
      [
        doc('Does the Harborlight intro read right?'),
        doc('Which Harborlight logo?', { what: 'the Harborlight page' }),
        ask('t-riverbend', 'Is the Riverbend axis right?'),
        ask('t-riverbend', 'Which Riverbend source?', { what: 'the Riverbend import' }),
      ],
      NOW,
    );
    expect(q.items.map((i) => i.ask)).toEqual([
      'Which Riverbend source?',
      'Is the Riverbend axis right?',
      'Which Harborlight logo?',
      'Does the Harborlight intro read right?',
    ]);
  });

  it('keeps the board order among ordinary asks (positive control)', () => {
    const tasks = [task('t-riverbend', 1), task('t-saltmarsh', 2)];
    const q = reviewQueue(
      tasks,
      [
        ask('t-saltmarsh', 'Which Saltmarsh date counts?'),
        ask('t-riverbend', 'Does the Riverbend chart read right?'),
      ],
      NOW,
    );
    expect(q.items.map((i) => i.ask)).toEqual([
      'Does the Riverbend chart read right?',
      'Which Saltmarsh date counts?',
    ]);
  });

  it('carries one line naming the stopped work and its goal, only on the blocking row', async () => {
    const q = reviewQueue(
      [task('t-riverbend', 1), task('t-saltmarsh', 2)],
      [
        ask('t-riverbend', 'Does the Riverbend chart read right?'),
        ask('t-saltmarsh', 'Which Saltmarsh date counts?', {
          what: 'the Saltmarsh re-run',
          goalId: 'g-launch',
        }),
      ],
      NOW,
      [{ id: 'g-launch', title: 'Ship the Harborlight launch' }],
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    homeReviewData.value = { queue: q, settled: [], now: NOW };
    const unmount = mountHomeReviewIsland(host, {
      onReview: vi.fn(),
      onOpen: vi.fn(),
      onOpenThread: vi.fn(),
      onWalkthrough: vi.fn(),
    });
    await tick();
    const lines = [...host.querySelectorAll('.board-review-row')].map(
      (row) => row.querySelector('.board-review-row-stops')?.textContent ?? null,
    );
    expect(lines).toEqual([
      null,
      'Stopped until you answer: the Saltmarsh re-run — stops work on Ship the Harborlight launch',
    ]);
    unmount();
    host.remove();
  });
});
