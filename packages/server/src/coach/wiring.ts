/**
 * The coach, composed against the server's own stores: one call from
 * `server.ts`, so the router carries a handle and nothing else.
 *
 * What it reaches, and why each is enough:
 *  - the doc store, to make, read and append to the learning-goals doc and
 *    to make the memory doc;
 *  - the task store, to make the coach's board and to name a doc's board;
 *  - the activity record's live feed (`onActivity`), for this data dir only;
 *  - the Coach board's lead, and an addressed frame to it: the coach's
 *    Claude Code session, which hears every event (`session-feed.ts`).
 */
import { agentIdForName } from '@claude-workspaces/core';
import { type Event, onActivity } from '../activity.ts';
import { type BoardPrivacy, placeIsOff } from './exclusion.ts';
import { type GoalsDocReading, readGoalsDoc } from './goals-doc.ts';
import { CoachHub } from './hub.ts';
import { coachSectionFor } from './landing.ts';
import { type Coach, type DocLabel, createCoach } from './moment.ts';
import { SessionFeed, type SessionFrame } from './session-feed.ts';
import { type CoachSetupDeps, ensureMemoryDoc } from './setup.ts';
import { CoachStore } from './store.ts';
import { CoachStream } from './stream.ts';

export interface CoachWiringDeps {
  dataDir: string;
  docStore: {
    prewarmHydration(docId: string): Promise<unknown>;
    createForCaller(
      docId: string,
      init: { type: 'markdown'; sourceUrl: string; title: string; workspaceId: string },
    ): { ok: true; doc: { docId: string } } | { ok: false };
    attachFileAsync(docId: string, path: string): Promise<{ ok: boolean }>;
    docExists(docId: string): boolean;
    readMarkdownBody(docId: string): string | null;
  };
  createBoard: (name: string) => string;
  fileUnderBoard: (docId: string, workspaceId: string) => void;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** What makes a board off for the coach (`coach/exclusion.ts`). */
  privacy: BoardPrivacy;
  /** The board's lead agent, if one is seated. */
  leadOf: (workspaceId: string) => string | undefined;
  sendToAgent: (workspaceId: string, agentId: string, frame: SessionFrame) => number;
  /** Whether that agent holds a stream on the board right now. */
  agentConnected: (workspaceId: string, agentId: string) => boolean;
  now?: () => number;
  /** The digest window's timer (`SessionFeedDeps.schedule`). */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface CoachWiring {
  store: CoachStore;
  coach: Coach;
  hub: CoachHub;
  feed: SessionFeed;
  setup: CoachSetupDeps;
  /** The front page's section, for the owner. */
  landing: () => string;
  /** True when this agent, by name, is the coach session: the lead seated
   *  on the board that holds the learning-goals doc. */
  isCoachSession: (workspaceId: string, agentName: string) => boolean;
  stop: () => void;
}

export function wireCoach(deps: CoachWiringDeps): CoachWiring {
  const store = new CoachStore(deps.dataDir);
  // An unreadable state file means the boards he turned off are unknown.
  const isOff = (place: { workspaceId: string; docId?: string }) =>
    store.readFailed || placeIsOff(place, deps.privacy, store.offBoards);
  const hub = new CoachHub({ hiddenAt: isOff });
  const readGoals = (): GoalsDocReading | null => {
    const doc = store.goalsDoc;
    const md = doc ? deps.docStore.readMarkdownBody(doc.docId) : null;
    return md === null ? null : readGoalsDoc(md);
  };
  const feed = new SessionFeed({
    lead: () => {
      const ws = store.goalsDoc?.workspaceId;
      const agentId = ws ? deps.leadOf(ws) : undefined;
      return ws && agentId ? { workspaceId: ws, agentId } : null;
    },
    send: deps.sendToAgent,
    connected: deps.agentConnected,
    eventsOn: (at) => store.eventsOn(at),
    countTurn: (at) => store.countEvent(at),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  });
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals,
    label: deps.label,
    boardName: deps.boardName,
    workspaceOf: deps.workspaceOf,
    isOff,
    tell: (news, at) => feed.send(news, at),
    publish: (frame) => hub.publish(frame),
    reshow: (frame) => hub.reshow(frame),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const unsubscribe = onActivity((dataDir: string, event: Event) => {
    if (dataDir === deps.dataDir) coach.activity(event);
  });
  const setup: CoachSetupDeps = {
    dataDir: deps.dataDir,
    createBoard: deps.createBoard,
    createDoc: async (docId, path, title, workspaceId) => {
      await deps.docStore.prewarmHydration(docId);
      const created = deps.docStore.createForCaller(docId, {
        type: 'markdown',
        sourceUrl: path,
        title,
        workspaceId,
      });
      if (!created.ok) return null;
      const id = created.doc.docId;
      deps.fileUnderBoard(id, workspaceId);
      const attached = await deps.docStore.attachFileAsync(id, path);
      return attached.ok ? id : null;
    },
    docExists: (docId) => deps.docStore.docExists(docId),
  };
  // A board set up before the memory doc existed gets one now.
  void ensureMemoryDoc(store, setup, (deps.now ?? Date.now)()).catch((err) =>
    console.warn(`[coach] memory doc not made: ${String(err)}`),
  );
  return {
    store,
    coach,
    hub,
    feed,
    setup,
    landing: () => {
      const t = (deps.now ?? Date.now)();
      return coachSectionFor(
        store,
        readGoals,
        { online: feed.reachable(), paused: feed.paused(t), boardName: deps.boardName },
        t,
      );
    },
    isCoachSession: (workspaceId, agentName) => {
      if (store.goalsDoc?.workspaceId !== workspaceId) return false;
      const lead = deps.leadOf(workspaceId);
      return lead !== undefined && lead === agentIdForName(agentName);
    },
    stop: () => {
      unsubscribe();
      feed.stop();
      store.flush();
      hub.close();
    },
  };
}
