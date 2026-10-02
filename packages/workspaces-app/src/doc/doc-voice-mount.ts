/**
 * Everything voice on the review doc, in one call from the markdown mount:
 * the planning voice's cursor for every reader (`agent-focus.ts`), and for a
 * writer on a board the voice-comment mic (`doc-voice.ts`) and the planning
 * voice's card (`doc-interview.ts`), which a planning meeting opens by itself.
 * The board is the address's, not `ctx.workspaceId`.
 */
import type { User } from '@claude-workspaces/core';
import { currentWorkspaceId } from '../doc-path.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { type FocusPresence, wireAgentFocus } from './agent-focus.ts';
import { wireDocInterview } from './doc-interview-wire.ts';
import type { DocInterviewOpts } from './doc-interview.ts';
import { mountDocVoice } from './doc-voice.ts';

export function mountDocVoices(opts: {
  docId: string;
  user: User;
  editor: EditorHandle;
  editorMount: HTMLElement;
  presence: FocusPresence;
  canWrite: boolean;
  scope: MountScope;
  /** This page's meeting, which opens the planning voice on a plan. */
  meeting?: DocInterviewOpts['meeting'];
}): void {
  const { docId, user, editor, editorMount, scope } = opts;
  wireAgentFocus({ editor, presence: opts.presence, scope });
  const board = opts.canWrite ? currentWorkspaceId() : null;
  if (!board) return;
  mountDocVoice({ docId, user, editor, editorMount, scope });
  wireDocInterview({
    docId,
    workspaceId: board,
    user,
    scope,
    ...(opts.meeting ? { meeting: opts.meeting } : {}),
  });
}
