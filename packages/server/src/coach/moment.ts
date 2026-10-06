/**
 * The coach's loop: everything he does goes to the coach session, and a
 * moment comes back when the session sees one.
 *
 * Signals from his pages and his activity rows become events
 * (`coach/stream.ts`), and each event goes to the session as it happens
 * (`coach/session-feed.ts`). His answers to a moment and his how-readily
 * setting go too, so the session learns from them; nothing here holds a
 * timer, a cap or a spacing rule.
 *
 * A moment the session raises (`raise`) reaches his pages only when there is
 * a goal to act on, no other moment is open, and its quote checks out
 * (`coach/judge.ts`). It follows him: every page he opens shows it, and it
 * stays until he answers it. Moving never closes it. A page on a board the
 * coach is excluded from (`coach/exclusion.ts`) is not shown it, and the
 * moment stays open for the next page that may show it (`coach/hub.ts`).
 */
import type { Event } from '../activity.ts';
import { type GoalsDocReading, goalTitle } from './goals-doc.ts';
import { checkMoment } from './judge.ts';
import type { SessionNews } from './session-feed.ts';
import type { CoachStore } from './store.ts';
import type { CoachEvent, CoachStream, HereSignal, StreamStep } from './stream.ts';
import type { CoachMoment, CoachReadiness, MomentAnswer } from './types.ts';

export const DEFAULT_COACH_NAME = 'Your coach';

export interface DocLabel {
  title?: string;
  board?: string;
}

/** What a page is told. */
export type CoachFrame =
  | { type: 'moment'; moment: { id: string; at: number; name: string; line: string; goal: string } }
  | { type: 'clear'; id: string };

export type RaiseResult =
  | { ok: true; id: string }
  | { ok: false; error: 'no-goals' | 'moment-open' | 'bad-moment'; message: string };

export interface CoachDeps {
  store: CoachStore;
  stream: CoachStream;
  /** The goals doc as it reads now, or null when there is none. */
  readGoals: () => GoalsDocReading | null;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** Nothing about this place may reach the session (`coach/exclusion.ts`). */
  isOff: (place: { workspaceId: string; docId?: string }) => boolean;
  /** To the coach session; true when it took the frame. */
  tell: (news: SessionNews, at: number) => boolean;
  publish: (frame: CoachFrame) => void;
  /** Every open page is told again whether it shows the open moment: a
   *  board just turned off hides it there, one turned back on shows it. */
  reshow: (frame: CoachFrame | null) => void;
  now?: () => number;
}

export interface Coach {
  here(signal: Omit<HereSignal, 'at'>): void;
  activity(row: Event): void;
  /** The session raises a moment. */
  raise(body: Record<string, unknown> | null): RaiseResult;
  answer(id: string, answer: MomentAnswer): boolean;
  setReadiness(readiness: CoachReadiness): void;
  /** "Coach off for this board", or back on. Turning off the board he is on
   *  counts as his leaving it; the open moment stays open, hidden there. */
  setBoardOff(workspaceId: string, off: boolean): void;
  /** The open moment as a page shows it, if any. */
  openFrame(): CoachFrame | null;
}

export function createCoach(deps: CoachDeps): Coach {
  const now = deps.now ?? Date.now;
  const name = (reading: GoalsDocReading | null) => reading?.name ?? DEFAULT_COACH_NAME;

  const frameOf = (m: CoachMoment, reading: GoalsDocReading | null): CoachFrame => ({
    type: 'moment',
    moment: { id: m.id, at: m.at, name: name(reading), line: m.line, goal: m.goal },
  });

  const close = (m: CoachMoment, answer: MomentAnswer, t: number): boolean => {
    if (!deps.store.answer(m.id, answer, t)) return false;
    deps.publish({ type: 'clear', id: m.id });
    deps.tell({ event: 'coach.answer', momentId: m.id, answer, goal: m.goal, line: m.line }, t);
    return true;
  };

  const forward = (e: CoachEvent) => {
    const label = e.docId ? deps.label(e.docId) : {};
    const board = deps.boardName(e.workspaceId);
    deps.tell(
      {
        event: 'coach.event',
        kind: e.kind,
        boardId: e.workspaceId,
        ...(board ? { board } : {}),
        ...(e.docId ? { docId: e.docId } : {}),
        ...(label.title ? { doc: label.title } : {}),
        ...(e.heading ? { heading: e.heading } : {}),
        ...(e.text ? { text: e.text } : {}),
      },
      e.at,
    );
  };

  /** The events go to the session. A move closes nothing: the open moment
   *  goes with him. */
  const take = (step: StreamStep) => {
    for (const e of step.events) forward(e);
  };

  const reshow = () => {
    const m = deps.store.openMoment();
    if (m) deps.reshow(frameOf(m, deps.readGoals()));
  };

  return {
    here(signal) {
      const t = now();
      if (deps.isOff(signal)) {
        // A hidden page off the coach's boards tells it nothing at all.
        // It may have become off while the moment was showing there.
        if (signal.visible) {
          take(deps.stream.elsewhere(t));
          reshow();
        }
        return;
      }
      take(deps.stream.here({ ...signal, at: t }));
    },
    activity(row) {
      if (!row.isOwner) return;
      const t = now();
      const goalsDoc = deps.store.goalsDoc;
      if (goalsDoc && row.type === 'edit_session' && row.doc?.docId === goalsDoc.docId) {
        deps.store.noteGoalsChanged(t);
      }
      const docId = row.doc?.docId;
      const workspaceId = docId ? deps.workspaceOf(docId) : undefined;
      if (docId && workspaceId && deps.isOff({ workspaceId, docId })) {
        if (row.type === 'doc_open') take(deps.stream.elsewhere(t));
        return;
      }
      take(deps.stream.activity(row, t, deps.workspaceOf));
    },
    raise(body) {
      const t = now();
      const reading = deps.readGoals();
      const goals = reading?.goals ?? [];
      if (goals.length === 0) {
        return {
          ok: false,
          error: 'no-goals',
          message: 'He has no goals written under "What I want to do better".',
        };
      }
      if (deps.store.openMoment()) {
        return { ok: false, error: 'moment-open', message: 'A moment is already on his page.' };
      }
      const checked = checkMoment(body, goals);
      if (typeof checked === 'string') return { ok: false, error: 'bad-moment', message: checked };
      const goal = goals[checked.goalIndex];
      const place = deps.stream.current;
      const m = deps.store.addMoment({
        at: t,
        goalIndex: checked.goalIndex,
        goal: goal ? goalTitle(goal) : '',
        matched: checked.matched,
        observed: checked.observed,
        line: checked.line,
        ...(place ? { workspaceId: place.workspaceId } : {}),
        ...(place?.docId ? { docId: place.docId } : {}),
      });
      deps.publish(frameOf(m, reading));
      return { ok: true, id: m.id };
    },
    answer(id, answer) {
      const m = deps.store.openMoment();
      return m?.id === id ? close(m, answer, now()) : false;
    },
    setReadiness(readiness) {
      deps.store.setReadiness(readiness);
      deps.tell({ event: 'coach.preference', readiness }, now());
    },
    setBoardOff(workspaceId, off) {
      deps.store.setBoardOff(workspaceId, off);
      const place = deps.stream.current;
      if (off && place && deps.isOff(place)) take(deps.stream.elsewhere(now()));
      reshow();
    },
    openFrame() {
      const m = deps.store.openMoment();
      return m ? frameOf(m, deps.readGoals()) : null;
    },
  };
}
