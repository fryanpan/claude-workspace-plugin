/**
 * One corpus case through the real `VoiceRouter`, and what it did.
 *
 * The router runs over a fresh fixture (`voice-router-fixture.ts`) with its
 * real guardrail and executors. Only the doc store is recorded rather than
 * real: the two doc writes voice makes — a comment and a review-item answer
 * — land in a list, which is how the eval sees where Alice's words went.
 * Status and assignee moves are read back off the task store itself.
 */
import { BOARD_FEEDBACK_DOC_ID } from '../packages/server/src/doc-ids.ts';
import { taskBodyDocId, taskIdOfBodyDoc } from '../packages/server/src/task-projection.ts';
import type { VoiceClassifier } from '../packages/server/src/voice-classifier.ts';
import type { VoiceClassification, VoiceContext } from '../packages/server/src/voice-prompt.ts';
import { FEEDBACK_ASK, HELP_SPOKEN } from '../packages/server/src/voice-quick.ts';
import { type VoiceDocStore, VoiceRouter, statusAsk } from '../packages/server/src/voice.ts';
import type { Outcome, RouterCase } from './voice-router-corpus.ts';
import {
  ALICE,
  type BoardKey,
  type RouterFixture,
  type TaskKey,
  buildRouterFixture,
} from './voice-router-fixture.ts';

/** Which of the router's three paths answered. */
export type RouterPath = 'server' | 'model' | 'agent';

export interface CaseRun {
  observed: Outcome | { other: string };
  path: RouterPath;
  /** What the router said back, before the page shapes it for speech. */
  ack: string;
  route: string;
  /** Whether the classifier was asked at all. */
  asked: boolean;
  ms: number;
  classifierMs?: number;
  confidence?: number;
}

interface Write {
  verb: 'comment' | 'answer';
  docId: string;
  threadId: string | null;
  optionId?: string;
}

function contextFor(fx: RouterFixture, where: RouterCase['where']): VoiceContext {
  if ('board' in where) return { surface: 'board' };
  if ('task' in where) {
    const taskId = fx.taskIds[where.task];
    return { surface: 'task', taskId, ...(where.thread ? { threadId: where.thread } : {}) };
  }
  return { surface: 'doc', docId: where.doc, ...(where.thread ? { threadId: where.thread } : {}) };
}

function keyOfTask(fx: RouterFixture, taskId: string): string {
  return (Object.entries(fx.taskIds).find(([, id]) => id === taskId)?.[0] ?? taskId) as string;
}

/** A navigation, as the outcome it is: a start, another board, or the
 *  fixture key it opens. */
function navigated(fx: RouterFixture, navigate: string): Outcome {
  const url = new URL(navigate, 'http://board.test');
  const start = url.searchParams.get('start');
  if (start === 'plan' || start === 'meeting') return { start };
  const board = (Object.entries(fx.boardIds) as Array<[BoardKey, string]>).find(
    ([, id]) => url.pathname === `/workspaces/${encodeURIComponent(id)}`,
  );
  if (board) return { board: board[0] };
  return { open: openedKey(fx, url) };
}

function openedKey(fx: RouterFixture, url: URL): string {
  const task = url.searchParams.get('task');
  if (task) return keyOfTask(fx, task);
  const goal = url.searchParams.get('goal');
  if (goal) return Object.entries(fx.goalIds).find(([, id]) => id === goal)?.[0] ?? goal;
  const doc = url.pathname.match(/\/docs\/([^/]+)$/);
  if (doc?.[1]) return decodeURIComponent(doc[1]);
  const tail = url.pathname.split('/').pop() ?? '';
  return tail === encodeURIComponent(fx.workspaceId) ? 'tasks' : tail;
}

/**
 * A classifier that names the case's expected outcome: what a perfect model
 * would say. It isolates what the router does with a right answer — its ack
 * and its executors — from whether any model gets there.
 */
export function oracleClassifier(c: RouterCase, fx: RouterFixture): VoiceClassifier {
  const e = c.expect;
  const said =
    (classification: VoiceClassification): VoiceClassifier =>
    async () => ({
      classification,
    });
  if ('board' in e)
    return said({ kind: 'quick', quick: { kind: 'board', workspaceId: fx.boardIds[e.board] } });
  if ('start' in e) return said({ kind: 'quick', quick: { kind: 'start', start: e.start } });
  if ('feedback' in e) return said({ kind: 'quick', quick: { kind: 'feedback' } });
  if ('help' in e) return said({ kind: 'quick', quick: { kind: 'help' } });
  if ('brief' in e) return said({ kind: 'status' });
  if ('open' in e) {
    const place = e.open;
    if (place === 'home' || place === 'tasks' || place === 'activity') {
      return said({ kind: 'quick', quick: { kind: 'place', place } });
    }
    const task = fx.taskIds[place as TaskKey];
    if (task) return said({ kind: 'lookup', target: 'task', id: task });
    return said({ kind: 'lookup', target: 'doc', id: place });
  }
  return said({ kind: 'change' });
}

export async function runCase(
  c: RouterCase,
  classifier: VoiceClassifier | 'oracle' | undefined,
  clock: () => number = () => performance.now(),
): Promise<CaseRun> {
  const fx = buildRouterFixture();
  const classify = classifier === 'oracle' ? oracleClassifier(c, fx) : classifier;
  const writes: Write[] = [];
  const docStore: VoiceDocStore = {
    async postComment(docId, threadId) {
      writes.push({ verb: 'comment', docId, threadId });
      return { id: `c-${writes.length}` };
    },
    async answerReviewItem(docId, threadId, _commentId, _author, _text, optionId) {
      writes.push({ verb: 'answer', docId, threadId, ...(optionId ? { optionId } : {}) });
      return { ok: true };
    },
  };
  let asked = false;
  let classifierMs: number | undefined;
  let confidence: number | undefined;
  const timed: VoiceClassifier | undefined = classify
    ? async (input) => {
        asked = true;
        const t0 = clock();
        const r = await classify(input);
        classifierMs = clock() - t0;
        confidence = r.confidence;
        return r;
      }
    : undefined;
  const router = new VoiceRouter({
    tasks: fx.store,
    ...(timed ? { classify: timed } : {}),
    docStore,
    taskCommentDoc: (taskId) => taskBodyDocId(taskId),
    docTitle: (_ws, docId) => fx.docTitle(docId),
    docResource: (_ws, docId) => {
      const title = fx.docTitle(docId);
      return { ...(title ? { title } : {}), reviewItems: fx.reviewItems.get(docId) ?? [] };
    },
  });
  const before = new Map(fx.store.listTasks(fx.workspaceId).map((t) => [t.id, { ...t }]));
  const t0 = clock();
  const res = await router.handle(fx.workspaceId, {
    transcript: c.said,
    context: contextFor(fx, c.where),
    actor: ALICE,
  });
  const ms = clock() - t0;
  if (!res.ok) throw new Error('fixture board missing');

  const path: RouterPath =
    res.route === 'agent' || res.route === 'agent-queued' ? 'agent' : asked ? 'model' : 'server';
  const run = (observed: CaseRun['observed']): CaseRun => ({
    observed,
    path,
    ack: res.ack,
    route: res.route,
    asked,
    ms,
    ...(classifierMs !== undefined ? { classifierMs } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  });
  if (path === 'agent') return run({ agent: true });

  const write = writes[0];
  if (write) {
    if (write.docId === BOARD_FEEDBACK_DOC_ID) return run({ feedback: true });
    if (write.threadId !== null) {
      const item = fx.reviewItems.get(write.docId)?.find((i) => i.threadId === write.threadId);
      const option = item?.options?.find((o) => o.id === write.optionId)?.label;
      return run({ answer: write.threadId, ...(option ? { option } : {}) });
    }
    const taskId = taskIdOfBodyDoc(write.docId);
    return run({ comment: taskId ? keyOfTask(fx, taskId) : write.docId });
  }
  for (const t of fx.store.listTasks(fx.workspaceId)) {
    const was = before.get(t.id);
    const key = keyOfTask(fx, t.id) as TaskKey;
    if (was && was.status !== t.status && t.status !== 'triage') {
      return run({ status: key, to: t.status });
    }
    if (was && was.assignee !== t.assignee) return run({ assign: key, to: t.assignee });
  }
  if (res.navigate) return run(navigated(fx, res.navigate));
  if (/Did you mean/.test(res.ack) || res.ack.endsWith(FEEDBACK_ASK)) return run({ ask: true });
  if (res.ack.endsWith(HELP_SPOKEN)) return run({ help: true });
  // A read answered with no navigation and no write is the spoken brief
  // exactly when the router's own status predicate claimed the words.
  if (statusAsk(c.said)) return run({ brief: true });
  return run({ other: res.ack.replace(/^Heard: "[^"]*"\.\s*/, '').slice(0, 80) });
}

/** Whether a run did what the case expects. */
export function scored(c: RouterCase, observed: CaseRun['observed']): boolean {
  const same = (a: Outcome): boolean => JSON.stringify(a) === JSON.stringify(observed);
  return same(c.expect) || (c.also ?? []).some(same);
}

/** The outcome as one short phrase, for the report. */
export function describeOutcome(o: CaseRun['observed']): string {
  if ('other' in o) return `other(${o.other})`;
  if ('open' in o) return `open ${o.open}`;
  if ('status' in o) return `${o.status} → ${o.to}`;
  if ('assign' in o) return `assign ${o.assign} to ${o.to}`;
  if ('comment' in o) return `comment on ${o.comment}`;
  if ('answer' in o) return `answer ${o.answer}${o.option ? ` (${o.option})` : ''}`;
  if ('ask' in o) return 'ask which';
  if ('brief' in o) return 'status brief';
  if ('board' in o) return `board ${o.board}`;
  if ('start' in o) return `start ${o.start}`;
  if ('feedback' in o) return 'app feedback';
  if ('help' in o) return 'help';
  return 'agent';
}
