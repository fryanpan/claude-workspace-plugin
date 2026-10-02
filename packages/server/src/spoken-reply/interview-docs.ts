/**
 * The doc store and the board, narrowed to what an interview may do: check a
 * doc is on the board, read its outline, append under one heading, and put
 * the agent's cursor on the words it is asking about.
 *
 * The write is `applyBlockEdits` with `insert_under_heading` — the verb
 * `insert_blocks_under_heading` reaches over HTTP — under an author id of its
 * own, so a later agent edit that names one of these blocks is handled by the
 * same ownership rules as any other agent's block.
 */
import type { prose } from '@claude-workspaces/core';
import { AGENT_FOCUS_FIELD, type AgentFocus } from '@claude-workspaces/core/spoken-reply';
import type { Awareness } from 'y-protocols/awareness';
import type { BlockEditsAuthor, BlockEditsResult, DocOutline } from '../doc-outline-ops.ts';
import type { InterviewDocs, InterviewWrite } from './interview.ts';

export const INTERVIEW_AUTHOR: BlockEditsAuthor = {
  author: 'voice-interview',
  authorName: 'Interview',
  authorColor: '#2e7dd7',
};

export interface InterviewDocStore {
  readOutline(docId: string): DocOutline | null;
  /** The live doc, when it is in memory; its presence is what pages read. */
  get(docId: string): { awareness: Awareness } | undefined;
  applyBlockEdits(docId: string, edits: prose.BlockEdit[], who: BlockEditsAuthor): BlockEditsResult;
}

export function interviewDocs(
  docStore: InterviewDocStore,
  /** The board's doc ids — `taskStore.getWorkspace(ws)?.docIds`. */
  boardDocIds: (workspaceId: string) => readonly string[] | undefined,
): InterviewDocs {
  let seq = 0;
  return {
    onBoard: (workspaceId, docId) => boardDocIds(workspaceId)?.includes(docId) === true,
    outline: (docId) => docStore.readOutline(docId)?.blocks ?? null,
    writeUnder: (docId, headingId, markdown): InterviewWrite => {
      const res = docStore.applyBlockEdits(
        docId,
        [{ op: 'insert_under_heading', headingId, markdown }],
        INTERVIEW_AUTHOR,
      );
      if (!res.ok) return res.error === 'not-found' ? 'gone' : 'failed';
      const outcome = res.outcomes[0];
      if (outcome?.status === 'applied' || outcome?.status === 'suggested') return 'written';
      return outcome?.error === 'unknown-block' || outcome?.error === 'not-a-heading'
        ? 'gone'
        : 'failed';
    },
    focus: (docId, at) => {
      const live = docStore.get(docId);
      if (!live) return;
      const state: AgentFocus | null = at
        ? {
            ...at,
            name: 'Claude',
            color: INTERVIEW_AUTHOR.authorColor ?? '#2e7dd7',
            seq: ++seq,
          }
        : null;
      live.awareness.setLocalStateField(AGENT_FOCUS_FIELD, state);
    },
  };
}
