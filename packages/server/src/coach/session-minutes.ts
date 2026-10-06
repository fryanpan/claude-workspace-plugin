/**
 * The owner's time in Claude Code sessions, as the coach's digest counts it.
 *
 * The digest saw only board pages, and most of his lower-priority time goes
 * in terminals. Every attached session already posts one note per turn end
 * (the plugin's Stop hook), with the session's id and working directory. So
 * each digest also lists, per session, the repo and its active minutes.
 *
 * What reaches the coach: the board's id and name, the repo's folder name,
 * the minutes and the turn count. Never the turn's text, the session id or
 * any other part of the path.
 *
 * Who counts. A note does not say whether a person or a channel woke the
 * turn, so the server cannot tell his turns from an agent's own. The proxy
 * is the seat: only the board's lead counts, the session he talks to on that
 * board, and the coach's own session never does. A lead working alone on
 * channel wakes is counted too; a session he drives that is not a lead is
 * not. The cap below bounds the first error.
 *
 * Active minutes. A turn end counts the time since the same session's
 * previous turn end, at most `TURN_CAP_MS`; a session's first turn counts
 * `FIRST_TURN_MS`. Five minutes is about one read-and-reply; a longer gap is
 * time the session worked alone or he was elsewhere, and counting it whole
 * is what would overstate.
 *
 * Pure apart from `SessionClock`'s memory; every time is handed in.
 */
import { basename } from 'node:path';

/** The most one turn end adds. */
export const TURN_CAP_MS = 5 * 60_000;
/** What a session's first known turn adds. */
export const FIRST_TURN_MS = 60_000;
/** Sessions whose last turn the clock remembers before it forgets the oldest. */
const SESSIONS_CAP = 500;
const REPO_MAX = 100;

export const SESSIONS_NOT_COUNTED =
  'Claude Code sessions not attached to a board are not counted, and neither are turns from a session that is not the board lead.';

/** One counted turn end, with the time it adds. */
export interface SessionTurn {
  at: number;
  boardId: string;
  board?: string;
  /** Which session; used to group, never sent. */
  session: string;
  repo: string;
  creditMs: number;
}

/** One session's line in a digest. */
export interface SessionMinutes {
  boardId: string;
  board?: string;
  repo: string;
  minutes: number;
  turns: number;
}

/**
 * The repo's folder name from a session's working directory. A worktree under
 * `<repo>/.claude/worktrees/<name>` is its repo, not its branch folder.
 * Undefined for anything that is not an absolute path.
 */
export function repoOfCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
  const trimmed = cwd.replace(/\/+$/, '');
  const worktree = trimmed.indexOf('/.claude/worktrees/');
  const root = worktree > 0 ? trimmed.slice(0, worktree) : trimmed;
  const name = basename(root);
  return name === '' || name.length > REPO_MAX ? undefined : name;
}

/** Remembers each session's last turn end, so a turn knows its gap. */
export class SessionClock {
  private readonly last = new Map<string, number>();

  /** The time this turn end adds, and it becomes the session's last. */
  credit(session: string, at: number): number {
    const prev = this.last.get(session);
    this.last.delete(session);
    this.last.set(session, prev === undefined ? at : Math.max(prev, at));
    while (this.last.size > SESSIONS_CAP) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
    if (prev === undefined) return FIRST_TURN_MS;
    return Math.min(Math.max(0, at - prev), TURN_CAP_MS);
  }
}

/** One line per session, in the order each first turned in the window. */
export function sessionMinutesOf(turns: readonly SessionTurn[]): SessionMinutes[] {
  const bySession = new Map<string, SessionMinutes & { ms: number }>();
  for (const t of turns) {
    const key = `${t.boardId}\u0000${t.session}`;
    const line = bySession.get(key) ?? {
      boardId: t.boardId,
      ...(t.board ? { board: t.board } : {}),
      repo: t.repo,
      minutes: 0,
      turns: 0,
      ms: 0,
    };
    line.repo = t.repo;
    line.turns += 1;
    line.ms += t.creditMs;
    bySession.set(key, line);
  }
  return [...bySession.values()].map(({ ms, ...line }) => ({
    ...line,
    minutes: Math.max(1, Math.round(ms / 60_000)),
  }));
}
