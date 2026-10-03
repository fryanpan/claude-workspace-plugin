/**
 * Workflow A's first step: "Set up my coach" makes the learning-goals doc,
 * once, on a board of the coach's own.
 *
 * The doc is an ordinary markdown doc bound to `<dataDir>/coach/
 * learning-goals.md`, so it has comments, history and the voice interview
 * like any other. Its board is named "Coach" and is created here, unshared,
 * so the doc sits on no board anybody else works in.
 *
 * Idempotent: a second setup returns the doc the first made while it still
 * exists. An existing file is never overwritten.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDocId } from '../doc-ids.ts';
import { goalSection, goalsDocTemplate, readGoalsDoc } from './goals-doc.ts';
import { COACH_DIRNAME, type CoachStore } from './store.ts';
import type { CoachGoalsDoc } from './types.ts';

export const COACH_BOARD_NAME = 'Coach';
export const GOALS_DOC_TITLE = 'Learning goals';

export interface CoachSetupDeps {
  dataDir: string;
  createBoard: (name: string) => string;
  /** Bind `path` as a markdown doc on the board: the doc's own id, or
   *  null when it failed. */
  createDoc: (
    docId: string,
    path: string,
    title: string,
    workspaceId: string,
  ) => Promise<string | null>;
  docExists: (docId: string) => boolean;
  readMarkdown: (docId: string) => string | null;
  /** Append markdown at the end of the doc, as the coach. */
  appendMarkdown: (docId: string, markdown: string) => boolean;
}

export const goalsDocPath = (dataDir: string) => join(dataDir, COACH_DIRNAME, 'learning-goals.md');

export async function ensureGoalsDoc(
  store: CoachStore,
  deps: CoachSetupDeps,
  now: number,
): Promise<CoachGoalsDoc | null> {
  const held = store.goalsDoc;
  if (held && deps.docExists(held.docId)) return held;
  const path = goalsDocPath(deps.dataDir);
  if (!existsSync(path)) {
    mkdirSync(join(deps.dataDir, COACH_DIRNAME), { recursive: true });
    writeFileSync(path, goalsDocTemplate(), { mode: 0o600 });
  }
  const workspaceId = held?.workspaceId ?? deps.createBoard(COACH_BOARD_NAME);
  const docId = await deps.createDoc(newDocId(), path, GOALS_DOC_TITLE, workspaceId);
  if (!docId) return null;
  const doc = { workspaceId, docId, createdAt: now };
  store.setGoalsDoc(doc);
  return doc;
}

/** "Add a goal": four empty parts at the end, numbered after the rest. */
export function addGoal(store: CoachStore, deps: CoachSetupDeps): boolean {
  const doc = store.goalsDoc;
  if (!doc) return false;
  const md = deps.readMarkdown(doc.docId);
  if (md === null) return false;
  const sections = (md.match(/^##\s+(?!#)/gm) ?? []).length;
  const goals = Math.max(readGoalsDoc(md).goals.length, sections - 1);
  return deps.appendMarkdown(doc.docId, goalSection(goals + 1));
}
