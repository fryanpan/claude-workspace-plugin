/**
 * Where a share link lands once the reader has signed in.
 *
 * A link used to open its board, always: a collaborator sent a link to one
 * doc signed in and then had to find the doc on the board.
 * A link now names one resource on its board — the board's Home, the board,
 * a task, a doc, a mock or a dev server — and redeeming it redirects there.
 *
 * The landing is a REDIRECT and nothing else, so it grants nothing: the page
 * it points at is judged by the same per-request membership gate as every
 * other request on the share hostname. What keeps it honest is the check at
 * mint time, which refuses a resource that is not on the link's own board —
 * a link to board A must not become a signpost into board B, even one the
 * gate would then refuse. The refusal reads the same for an id on another
 * board as for an id that does not exist, so the mint route cannot be used
 * to ask which ids are real elsewhere.
 *
 * The check runs again at redeem time, because a resource can leave the
 * board after the link was made. A landing no longer on the board falls back
 * to the board itself rather than to a refusal.
 */

/** The resource kinds a link can land on. `app` is an attached dev server. */
export const LANDING_KINDS = ['home', 'board', 'task', 'doc', 'mockup', 'app'] as const;
export type ShareLandingKind = (typeof LANDING_KINDS)[number];

export type ShareLanding =
  | { kind: 'home' | 'board' }
  | { kind: 'task' | 'doc' | 'mockup' | 'app'; id: string };

/** No id a board mints is anywhere near this long. */
const MAX_ID_CHARS = 200;

const needsId = (kind: ShareLandingKind): kind is 'task' | 'doc' | 'mockup' | 'app' =>
  kind !== 'home' && kind !== 'board';

/**
 * Read a landing off a request body or a stored record. `undefined` in is the
 * board, the default every link minted before landings existed has.
 */
export function parseShareLanding(
  raw: unknown,
): { ok: true; landing: ShareLanding | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, landing: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'landing must be an object: { kind, id? }' };
  }
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string' || !(LANDING_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `landing.kind must be one of ${LANDING_KINDS.join(', ')}` };
  }
  const k = kind as ShareLandingKind;
  if (!needsId(k)) return { ok: true, landing: { kind: k } };
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_CHARS) {
    return { ok: false, error: `landing.id is required for kind ${k}` };
  }
  return { ok: true, landing: { kind: k, id } };
}

/** What `landingOnBoard` needs to know about the board and its contents. */
export interface LandingLookups {
  /** The board a task row lives on, or undefined for no such task. */
  taskBoardOf: (taskId: string) => string | undefined;
  /** The ids of the docs filed on a board, canonical. */
  boardDocIds: (workspaceId: string) => readonly string[];
  /** A name or alias resolved to the doc id it names. */
  resolveDocId: (docId: string) => string;
  /** A doc's type, or undefined for no such doc. */
  docTypeOf: (docId: string) => string | undefined;
}

/** The lookups, read off this server's two stores. */
export function landingLookupsFor(
  tasks: {
    getTask: (id: string) => { workspaceId: string } | undefined;
    getWorkspace: (id: string) => { docIds: readonly string[] } | undefined;
  },
  docs: {
    resolveDocId: (id: string) => string;
    peekMeta: (id: string) => { type?: string } | undefined;
  },
): LandingLookups {
  return {
    taskBoardOf: (taskId) => tasks.getTask(taskId)?.workspaceId,
    boardDocIds: (wsId) => tasks.getWorkspace(wsId)?.docIds ?? [],
    resolveDocId: (docId) => docs.resolveDocId(docId),
    docTypeOf: (docId) => docs.peekMeta(docId)?.type,
  };
}

/** The doc type each doc-shaped kind must be. */
const DOC_TYPE: Record<'doc' | 'mockup' | 'app', string> = {
  doc: 'markdown',
  mockup: 'mockup',
  app: 'app',
};

/**
 * The landing with its id made canonical, when the resource it names is on
 * `workspaceId` and is the kind it claims; otherwise null.
 */
export function landingOnBoard(
  workspaceId: string,
  landing: ShareLanding,
  look: LandingLookups,
): ShareLanding | null {
  if (!('id' in landing)) return landing;
  const { kind } = landing;
  if (kind === 'task') {
    return look.taskBoardOf(landing.id) === workspaceId ? landing : null;
  }
  const id = look.resolveDocId(landing.id);
  if (!look.boardDocIds(workspaceId).includes(id)) return null;
  if (look.docTypeOf(id) !== DOC_TYPE[kind]) return null;
  return { kind, id };
}

/** The same-origin path a landing opens at. Every id is encoded. */
export function landingPath(workspaceId: string, landing: ShareLanding | undefined): string {
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (!landing) return board;
  switch (landing.kind) {
    case 'home':
      return `${board}/home`;
    case 'board':
      return board;
    case 'task':
      return `${board}?task=${encodeURIComponent(landing.id)}`;
    case 'doc':
      return `${board}/docs/${encodeURIComponent(landing.id)}`;
    case 'mockup':
      return `${board}/mockups/${encodeURIComponent(landing.id)}`;
    case 'app':
      return `${board}/apps/${encodeURIComponent(landing.id)}/`;
  }
}
