/**
 * The coach's digest lists the owner's Claude Code time: per attached
 * session, the repo and its active minutes, and never what the turn said.
 * Only a board's lead counts, the coach's own session never does, a board
 * the coach is off for is left out entirely, and every digest says once that
 * sessions with no board are not counted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core';
import type { BoardPrivacy } from '../src/coach/exclusion.ts';
import {
  FIRST_TURN_MS,
  SESSIONS_NOT_COUNTED,
  SessionClock,
  TURN_CAP_MS,
  repoOfCwd,
} from '../src/coach/session-minutes.ts';
import { type CoachWiringDeps, wireCoach } from '../src/coach/wiring.ts';
import { GOALS_DOC, at } from './coach-fixtures.ts';

const MIN = 60_000;
const HARBOR_LEAD = 'Harborlight lead';
const RIVER_LEAD = 'Riverbend lead';
const COACH = 'Saltmarsh coach';
const LEADS: Record<string, string> = {
  'w-coach': agentIdForName(COACH),
  'w-harbor': agentIdForName(HARBOR_LEAD),
  'w-river': agentIdForName(RIVER_LEAD),
};
const NAMES: Record<string, string> = { 'w-harbor': 'Harborlight', 'w-river': 'Riverbend' };
const SECRET_TEXT = 'Berths 4 and 5 are free after the tide turns.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-minutes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wire(privacy: Partial<BoardPrivacy> = {}) {
  const windows: (() => void)[] = [];
  const sent: unknown[] = [];
  const deps: CoachWiringDeps = {
    dataDir: dir,
    docStore: {
      prewarmHydration: async () => undefined,
      createForCaller: (docId) => ({ ok: true, doc: { docId } }),
      attachFileAsync: async () => ({ ok: true }),
      docExists: () => true,
      readMarkdownBody: () => GOALS_DOC,
    },
    createBoard: () => 'w-coach',
    fileUnderBoard: () => {},
    label: () => ({}),
    boardName: (ws) => NAMES[ws],
    workspaceOf: () => 'w-coach',
    privacy: {
      localOnlyBoard: () => false,
      localOnlyDoc: () => false,
      locked: () => false,
      shared: () => false,
      boardsOfDoc: () => [],
      ...privacy,
    },
    leadOf: (ws) => LEADS[ws],
    sendToAgent: (_ws, _agent, frame) => {
      sent.push(frame);
      return 1;
    },
    agentConnected: () => true,
    planBoard: () => undefined,
    now: () => at(9),
    schedule: (fn) => {
      windows.push(fn);
      return () => {};
    },
  };
  const w = wireCoach(deps);
  w.store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: at(9) });
  const closeWindows = () => {
    for (const close of windows.splice(0)) close();
  };
  return { w, sent, closeWindows };
}

const turnNote = (agent: string, minute: number, sessionId = 'sess-1') => ({
  agent,
  kind: 'turn' as const,
  text: SECRET_TEXT,
  at: at(9, minute),
  sessionId,
});
const HARBOR_CWD = '/home/alice/dev/harborlight-app/.claude/worktrees/tide-tables';

describe('the digest’s Claude Code section', () => {
  it('lists repo and active minutes per attached session, without the turn text, and says once that unattached sessions are not counted', () => {
    const { w, sent, closeWindows } = wire();
    for (const minute of [0, 3, 13]) {
      expect(w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, minute), HARBOR_CWD)).toBe(true);
    }
    w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, 4, 'sess-2'), '/home/alice/dev/saltmarsh');
    closeWindows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'coach.digest',
      items: [],
      sessions: [
        {
          boardId: 'w-harbor',
          board: 'Harborlight',
          repo: 'harborlight-app',
          minutes: 9,
          turns: 3,
        },
        { boardId: 'w-harbor', board: 'Harborlight', repo: 'saltmarsh', minutes: 1, turns: 1 },
      ],
      sessionsNote: SESSIONS_NOT_COUNTED,
    });
    const frame = JSON.stringify(sent[0]);
    expect(frame).not.toContain('Berths');
    expect(frame).not.toContain('sess-1');
    expect(frame).not.toContain('/home');
    expect(frame).not.toContain('tide-tables');
    expect(frame.split(SESSIONS_NOT_COUNTED)).toHaveLength(2);
    w.stop();
  });

  it('leaves out a session on a board the coach is off for, entirely', () => {
    const { w, sent, closeWindows } = wire({ shared: (ws) => ws === 'w-river' });
    expect(w.sessionTurn('w-river', turnNote(RIVER_LEAD, 0), '/home/bob/riverbend')).toBe(false);
    closeWindows();
    expect(sent).toEqual([]);
    w.sessionTurn('w-river', turnNote(RIVER_LEAD, 1), '/home/bob/riverbend');
    w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, 2), HARBOR_CWD);
    closeWindows();
    expect(JSON.stringify(sent)).not.toContain('iverbend');
    expect(JSON.stringify(sent)).not.toContain('w-river');
    w.store.setBoardOff('w-harbor', true);
    expect(w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, 3), HARBOR_CWD)).toBe(false);
    w.stop();
  });

  it('counts only the board lead’s turn ends, and never the coach’s own session', () => {
    const { w, sent, closeWindows } = wire();
    expect(w.sessionTurn('w-harbor', turnNote('Bob', 0), HARBOR_CWD)).toBe(false);
    expect(w.sessionTurn('w-harbor', { ...turnNote(HARBOR_LEAD, 0), kind: 'denial' })).toBe(false);
    expect(w.sessionTurn('w-coach', turnNote(COACH, 0), '/home/alice/coach')).toBe(false);
    closeWindows();
    expect(sent).toEqual([]);
  });
});

describe('SessionClock', () => {
  it('counts the gap since the session’s last turn end, capped, and a first turn as a minute', () => {
    const clock = new SessionClock();
    expect(clock.credit('a', 0)).toBe(FIRST_TURN_MS);
    expect(clock.credit('a', 2 * MIN)).toBe(2 * MIN);
    expect(clock.credit('a', 60 * MIN)).toBe(TURN_CAP_MS);
    expect(clock.credit('b', 61 * MIN)).toBe(FIRST_TURN_MS);
    expect(clock.credit('a', 59 * MIN)).toBe(0);
  });
});

describe('repoOfCwd', () => {
  it('names the repo folder, a worktree by its repo, and nothing for a non-path', () => {
    expect(repoOfCwd('/home/alice/dev/harborlight-app')).toBe('harborlight-app');
    expect(repoOfCwd('/home/alice/dev/harborlight-app/')).toBe('harborlight-app');
    expect(repoOfCwd(HARBOR_CWD)).toBe('harborlight-app');
    expect(repoOfCwd('relative/riverbend')).toBeUndefined();
    expect(repoOfCwd(42)).toBeUndefined();
    expect(repoOfCwd('/')).toBeUndefined();
  });
});
