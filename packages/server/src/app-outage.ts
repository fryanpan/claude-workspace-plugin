/**
 * An attached app whose dev server stopped answering, told to the agent who
 * can start it again — once per outage.
 *
 * On 24 September an app's dev server crashed and stayed down for over two
 * hours. Every reader who opened it got an error page, the board owner asked
 * "Got bad gateway?" twice, and nothing logged the failure or woke anybody:
 * the proxy answered each request and forgot it. The fix for the reader is
 * the status in `routes/apps.ts`; this module is the fix for the agent.
 *
 * WHO IS TOLD. The agent that attached the app, from the `producedBy.agentId`
 * the attach records. An app attached before that was recorded carries only
 * `owner`, the attaching session's working directory, and no stream is keyed
 * on a directory — so it falls back to the board's lead, the one agent a
 * board always names as answerable for it. Neither known: the log line is
 * all there is, and it says so.
 *
 * ONCE PER OUTAGE. A page that fails loads a host page, and a reader who
 * refreshes loads it again, so a crash produces a failure per request per
 * reader. The first one starts the outage and wakes the agent; the rest are
 * the same news. A request that the dev server answers — whatever its status,
 * because a 404 from the app is the app running — ends the outage and re-arms
 * the notice for the next one. The state is in memory: a server restart
 * during an outage tells the agent again on the next failure, which is one
 * repeat after a deploy rather than a silence.
 *
 * ASK AGAIN. The waiting page a reader holds open offers "Ask again" once two
 * minutes have passed since the last notice; `askAgain` is that second
 * notice, marked `askedAgain`, and it refuses a repeat sooner than
 * `ASK_AGAIN_MS` however many times it is called.
 */

/** The addressed frame's event name, on the board's `ws~` channel. */
export const APP_UNREACHABLE_EVENT = 'workspace.app_unreachable';

/**
 * How long after one notice a reader may ask for another. The waiting page
 * (`app-waiting-page.ts`) offers "Ask again" only once this has passed since
 * the last notice, and `askAgain` refuses anything sooner, so a held-down
 * button or a script cannot wake the agent more than once per two minutes.
 */
export const ASK_AGAIN_MS = 2 * 60_000;

export interface AppUnreachableFrame {
  event: typeof APP_UNREACHABLE_EVENT;
  workspaceId: string;
  docId: string;
  title?: string;
  /** The loopback origin the proxy could not reach. */
  origin: string;
  /** The address readers open. */
  prefix: string;
  /** Why the fetch failed, as the runtime said it. */
  reason: string;
  /** Whether the addressee attached the app or is standing in as lead. */
  addressedAs: 'attacher' | 'lead';
  /** A reader on the waiting page asked again: the app is still down. */
  askedAgain?: true;
  /** When the outage started, on a repeat notice. */
  downSince?: number;
  ts: number;
}

export interface AppFailure {
  workspaceId: string;
  docId: string;
  title?: string;
  origin: string;
  prefix: string;
  reason: string;
  /** `producedBy.agentId` off the app doc, when the attach recorded one. */
  attachedBy?: string;
}

export interface AppOutageDeps {
  /** The board's lead agent id, or undefined when it has none. */
  leadOf: (workspaceId: string) => string | undefined;
  /** An addressed write to one agent's streams; returns the sinks reached. */
  send: (workspaceId: string, agentId: string, frame: AppUnreachableFrame) => number;
  log?: (line: string) => void;
  now?: () => number;
}

/** What the waiting page shows about one outage. */
export interface OutageView {
  /** When the first failure arrived. */
  since: number;
  /** When the agent was last told: the start, or the latest ask-again. */
  askedAt: number;
  /** When a reader last asked again, if one has. */
  askedAgainAt?: number;
  /** The agent told, or undefined when there was nobody to tell. */
  to?: string;
  addressedAs?: 'attacher' | 'lead';
}

export type AskAgainResult =
  | { ok: true; askedAt: number; to: string; addressedAs: 'attacher' | 'lead' }
  | { ok: false; reason: 'not_down' | 'nobody' }
  | { ok: false; reason: 'too_soon'; retryAt: number };

interface Outage extends OutageView {
  failure: AppFailure;
}

export class AppOutages {
  /** docId → its current outage. */
  private readonly down = new Map<string, Outage>();

  constructor(private readonly deps: AppOutageDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? console.warn)(line);
  }

  /** A proxy fetch to the app threw. Tells somebody only if this starts an
   *  outage; returns whether it did. */
  failed(f: AppFailure): boolean {
    if (this.down.has(f.docId)) return false;
    const ts = this.now();
    const lead = f.attachedBy ? undefined : this.deps.leadOf(f.workspaceId);
    const to = f.attachedBy ?? lead;
    const what = `[apps] ${f.docId} on ${f.workspaceId} stopped answering at ${f.origin} (${f.reason})`;
    if (to === undefined) {
      this.down.set(f.docId, { since: ts, askedAt: ts, failure: f });
      this.log(`${what}; nobody to tell: no attacher recorded and the board has no lead`);
      return true;
    }
    const addressedAs = f.attachedBy ? 'attacher' : 'lead';
    const outage: Outage = { since: ts, askedAt: ts, to, addressedAs, failure: f };
    this.down.set(f.docId, outage);
    this.tell(outage, to, addressedAs, what, false);
    return true;
  }

  /**
   * A reader on the waiting page asked for the agent to be told again. Only
   * during an outage, only when somebody was told the first time, and only
   * once `ASK_AGAIN_MS` has passed since the last notice.
   */
  askAgain(docId: string): AskAgainResult {
    const outage = this.down.get(docId);
    if (!outage) return { ok: false, reason: 'not_down' };
    const { to, addressedAs } = outage;
    if (to === undefined || addressedAs === undefined) return { ok: false, reason: 'nobody' };
    const ts = this.now();
    const retryAt = outage.askedAt + ASK_AGAIN_MS;
    if (ts < retryAt) return { ok: false, reason: 'too_soon', retryAt };
    outage.askedAt = ts;
    outage.askedAgainAt = ts;
    this.tell(
      outage,
      to,
      addressedAs,
      `[apps] ${docId} still down, and a reader asked again`,
      true,
    );
    return { ok: true, askedAt: ts, to, addressedAs };
  }

  private tell(
    outage: Outage,
    to: string,
    addressedAs: 'attacher' | 'lead',
    what: string,
    again: boolean,
  ): void {
    const f = outage.failure;
    const reached = this.deps.send(f.workspaceId, to, {
      event: APP_UNREACHABLE_EVENT,
      workspaceId: f.workspaceId,
      docId: f.docId,
      ...(f.title ? { title: f.title } : {}),
      origin: f.origin,
      prefix: f.prefix,
      reason: f.reason,
      addressedAs,
      ...(again ? { askedAgain: true as const, downSince: outage.since } : {}),
      ts: outage.askedAt,
    });
    // An addressed frame is buffered for the agent's reconnect even when no
    // stream is open, so zero is "held for replay", not "lost".
    this.log(
      `${what}; told ${to} (${addressedAs}${reached === 0 ? ', not listening now: held for its reconnect' : ''})`,
    );
  }

  /** The dev server answered. Ends any outage, so the next failure tells. */
  answered(docId: string): void {
    const outage = this.down.get(docId);
    if (outage === undefined) return;
    this.down.delete(docId);
    const secs = Math.round((this.now() - outage.since) / 1000);
    this.log(`[apps] ${docId} answering again after ${secs}s down`);
  }

  /** Whether the app is in an outage this process has told somebody about. */
  isDown(docId: string): boolean {
    return this.down.has(docId);
  }

  /** The current outage as the waiting page reads it, or undefined. */
  outage(docId: string): OutageView | undefined {
    const o = this.down.get(docId);
    if (!o) return undefined;
    return {
      since: o.since,
      askedAt: o.askedAt,
      ...(o.askedAgainAt !== undefined ? { askedAgainAt: o.askedAgainAt } : {}),
      ...(o.to !== undefined ? { to: o.to } : {}),
      ...(o.addressedAs !== undefined ? { addressedAs: o.addressedAs } : {}),
    };
  }
}
