import {
  AGENT_NOTES_PER_AGENT,
  AGENT_NOTES_WINDOW_MS,
  agentNotesByAgent,
} from '../agent-note-placement.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * `GET /workspaces/<ws>/agent-notes` — every agent's notes that no task took,
 * on this board.
 *
 * The board's one read of the unplaced-note log, grouped per agent and named
 * by state (agent-note-placement.ts) — the Home pane's "Not on a task" list.
 * Per agent because two of its three states have no task to hang on. Refused
 * to share visitors like the per-agent read in dispatch-and-notes.ts: a
 * session's own words, not the board's rows.
 *
 * Answers `undefined` for any other path so the caller's chain continues.
 */
export function handleBoardAgentNotesRead(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Response | undefined {
  const { req, scope, visitor } = rq;
  // Not `restIs`: its false branch would narrow `scope` for the caller.
  if (scope === undefined || scope.rest !== 'agent-notes') return undefined;
  const { agentNotes, agentNoteLog, j } = ctx;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
  const board = scope.workspaceId;
  const since = Date.now() - AGENT_NOTES_WINDOW_MS;
  const read = agentNoteLog.readBoard(board, since, AGENT_NOTES_PER_AGENT);
  const agents = agentNotesByAgent(
    read.lines,
    (agent) => {
      const placed = agentNotes
        .list(agent)
        .find((n) => n.workspaceId === board && n.taskId !== undefined);
      return placed?.taskId !== undefined ? { at: placed.at, taskId: placed.taskId } : undefined;
    },
    AGENT_NOTES_PER_AGENT,
    read.skipped,
  );
  return j(200, { workspaceId: board, since, agents });
}
