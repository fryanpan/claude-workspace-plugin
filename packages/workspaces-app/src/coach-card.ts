/**
 * The coach on a board or a doc: where Bryan is, sent to the server, and the
 * coach's "Hi, I'm noticing…" card when it has something to say.
 *
 * Where he is: one small POST to `/coach/here` when the page opens, when it
 * is hidden or shown, and at most once a minute while he is scrolling, typing
 * or pointing. A page left open with nobody at it sends nothing, so the
 * server counts no time for it. The doc page adds how far down he is and the
 * heading he is under.
 *
 * Only the owner has a coach. Anyone else's first POST gets an empty 204,
 * and the page then stops: no more beacons, and the stream is never opened.
 *
 * The card: calm by default. It sits in the bottom-left corner, does not
 * move or pulse, and leaves when he answers, when the server clears it, or
 * when the moment's ten minutes are up. Drawn in a shadow root so neither
 * page's stylesheet reaches it and it adds no rule to either.
 */

const HERE_URL = '/coach/here';
const STREAM_URL = '/coach/stream';
/** The longest a beacon waits after he does something. */
export const BEACON_EVERY_MS = 60_000;
/** The server's MOMENT_TTL_MS: a moment unanswered after this is gone. */
export const MOMENT_TTL_MS = 10 * 60_000;
const ACTIVITY_EVENTS = ['scroll', 'keydown', 'pointerdown', 'input', 'wheel'] as const;

export interface CoachMomentView {
  id: string;
  at: number;
  name: string;
  line: string;
  goal: string;
}

type Frame = { type: 'moment'; moment: CoachMomentView } | { type: 'clear'; id: string };

export interface CoachCardOptions {
  workspaceId: string;
  docId?: string;
  /** The doc's editor, whose headings say which part he is reading. */
  root?: HTMLElement;
  /** Injected by tests. */
  /** Answers the status, or 0 when the request never landed. */
  post?: (url: string, body: unknown) => Promise<number>;
  openStream?: (url: string) => EventSource;
  now?: () => number;
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.cw-coach { position: fixed; left: 16px; bottom: calc(var(--kb-bottom, 0px) + var(--doc-dock-h, 0px) + var(--board-bottom-bar, 0px) + 16px); z-index: 1050; width: min(340px, calc(100vw - 136px)); padding: 12px 14px; background: #fff; color: #1b1f23; border: 1px solid #d8dee4; border-left: 3px solid #5b7f4e; border-radius: 8px; box-shadow: 0 4px 16px rgba(27,31,35,.12); }
.cw-coach-who { margin: 0 0 4px; font-size: 12.5px; font-weight: 600; color: #5b7f4e; }
.cw-coach-line { margin: 0 0 6px; font-size: 14.5px; line-height: 1.4; }
.cw-coach-goal { margin: 0 0 10px; font-size: 12.5px; line-height: 1.35; color: #6e7781; }
.cw-coach-acts { display: flex; gap: 6px; }
.cw-coach-acts button { flex: 1 1 0; min-height: 44px; padding: 0 8px; border: 1px solid #d8dee4; border-radius: 6px; background: #fff; color: #1b1f23; font-size: 13.5px; cursor: pointer; }
.cw-coach-acts button:hover { background: #f6f8fa; }
.cw-coach-acts button:disabled { opacity: .55; cursor: default; }
`;

async function defaultPost(url: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** The element that scrolls the page: the doc's own pane, or the document. */
function scroller(root: HTMLElement | undefined): Element | null {
  for (let el = root?.parentElement ?? null; el; el = el.parentElement) {
    const y = getComputedStyle(el).overflowY;
    if ((y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return document.scrollingElement;
}

/** How far down, as a whole percent, and the last heading above the fold. */
function readingPlace(root: HTMLElement | undefined): { scrollPct?: number; heading?: string } {
  if (!root) return {};
  const el = scroller(root);
  const range = el ? el.scrollHeight - el.clientHeight : 0;
  const scrollPct = el && range > 0 ? Math.round((el.scrollTop / range) * 100) : 0;
  let heading: string | undefined;
  for (const h of root.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    if (h.getBoundingClientRect().top > 120) break;
    heading = h.textContent?.trim() || heading;
  }
  return { scrollPct: Math.min(100, Math.max(0, scrollPct)), ...(heading ? { heading } : {}) };
}

export interface CoachCard {
  destroy(): void;
}

export function mountCoachCard(opts: CoachCardOptions): CoachCard {
  const post = opts.post ?? defaultPost;
  const now = opts.now ?? Date.now;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let stopped = false;
  let sentAt = 0;
  let movedSince = false;
  let stream: EventSource | null = null;
  let host: HTMLElement | null = null;
  let shown: CoachMomentView | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const send = async (): Promise<number> => {
    sentAt = now();
    movedSince = false;
    return post(HERE_URL, {
      workspaceId: opts.workspaceId,
      ...(opts.docId ? { docId: opts.docId } : {}),
      visible: document.visibilityState !== 'hidden',
      timeZone,
      ...readingPlace(opts.root),
    });
  };
  const onActivity = () => {
    if (stopped) return;
    movedSince = true;
    if (now() - sentAt >= BEACON_EVERY_MS) void send();
  };
  const onVisibility = () => {
    if (!stopped) void send();
  };
  // A burst of activity sends its first ping at once; this sends the rest at
  // most once a minute, and only if he did something since.
  const tick = setInterval(() => {
    if (!stopped && movedSince && document.visibilityState !== 'hidden') void send();
  }, BEACON_EVERY_MS);

  const hide = (id?: string) => {
    if (id && shown?.id !== id) return;
    clearTimeout(expiry);
    shown = null;
    host?.remove();
    host = null;
  };

  const answer = async (id: string, value: string, buttons: HTMLButtonElement[]) => {
    for (const b of buttons) b.disabled = true;
    if ((await post(`/coach/moments/${encodeURIComponent(id)}/answer`, { answer: value })) === 200)
      hide(id);
    else for (const b of buttons) b.disabled = false;
  };

  const show = (m: CoachMomentView) => {
    const left = m.at + MOMENT_TTL_MS - now();
    if (left <= 0) return;
    hide();
    shown = m;
    host = document.createElement('div');
    host.className = 'coach-card-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const card = document.createElement('div');
    card.className = 'cw-coach';
    card.setAttribute('role', 'status');
    const line = (cls: string, text: string) => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      return p;
    };
    const acts = document.createElement('div');
    acts.className = 'cw-coach-acts';
    const buttons = (
      [
        ['thanks', 'Thanks'],
        ['not-now', 'Not now'],
        ['not-this', 'Not this'],
      ] as const
    ).map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.answer = value;
      b.textContent = label;
      return b;
    });
    for (const b of buttons) {
      b.addEventListener('click', () => void answer(m.id, b.dataset.answer ?? '', buttons));
      acts.appendChild(b);
    }
    card.append(
      line('cw-coach-who', m.name),
      line('cw-coach-line', m.line),
      line('cw-coach-goal', `Your goal: ${m.goal}`),
      acts,
    );
    shadow.append(style, card);
    document.body.appendChild(host);
    expiry = setTimeout(() => hide(m.id), left);
  };

  const onFrame = (ev: MessageEvent) => {
    let frame: Frame;
    try {
      frame = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (frame.type === 'moment') show(frame.moment);
    else if (frame.type === 'clear') hide(frame.id);
  };

  for (const e of ACTIVITY_EVENTS)
    document.addEventListener(e, onActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  const destroy = () => {
    stopped = true;
    clearInterval(tick);
    for (const e of ACTIVITY_EVENTS) document.removeEventListener(e, onActivity, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    stream?.close();
    stream = null;
    hide();
  };

  // 200 is the owner; anything else (204 for anyone else) stops the page.
  void send().then((status) => {
    if (status !== 200) return destroy();
    if (stopped) return;
    if (!opts.openStream && typeof EventSource === 'undefined') return;
    stream = (opts.openStream ?? ((url) => new EventSource(url)))(STREAM_URL);
    stream.addEventListener('coach', onFrame as EventListener);
  });

  return { destroy };
}
