/**
 * The page a reader gets while an attached app's dev server is down.
 *
 * It replaced a dead end. The old page said "Ask the agent that attached it
 * to start it, then refresh this page", which asked the reader to do two
 * things the server had already done or could do: the agent is told when the
 * outage starts (`app-outage.ts`), and the page can find out for itself when
 * the app is back. So this one says who was asked and when, waits, and opens
 * the app on its own as soon as it answers.
 *
 * FOUR STATES, one steady dot. Waiting (blue) for the first two minutes after
 * the agent was told; stuck (orange) once two minutes pass with no answer,
 * which is when "Ask <agent> again" appears; asked again (orange, button
 * disabled) for two minutes after a reader asks. With nobody recorded as the
 * attacher the board lead is the one named; with no lead either, nobody was
 * asked and the page says so and offers no button. The button's row keeps
 * its space in every state and the button keeps its size, so nothing moves
 * when it appears or changes label.
 *
 * HOW IT LEARNS THE APP IS BACK: a HEAD of its own address every three
 * seconds. That is the same proxy path a reader's load takes, so it answers
 * exactly the question the reload would — and the request that finds the app
 * answering is also the one that ends the outage server-side. A HEAD carries
 * no body, a refused loopback connect costs the server well under a
 * millisecond, and a share visitor may already make it (the host guard admits
 * GET and HEAD under an app). The down answer carries `x-cw-app-down`, so the
 * page tells this server's 503 apart from anything else: the app's own
 * status, or the edge's page while this server restarts.
 *
 * In the mock host's sandboxed frame the page has an opaque origin, so it can
 * neither read its own HEAD nor post an ask. There it reloads itself every
 * five seconds instead, and the ask button stays hidden; the times it shows
 * come from the server, so a reload keeps the state.
 *
 * Every name on the page comes from a record — the app doc's title, the
 * identity roster — never from the request, and each is escaped here: into
 * HTML with `escape`, and into the script's JSON with `<` written as
 * `<` so no value can close the script element.
 */
import type { OutageView } from './app-outage.ts';
import { ASK_AGAIN_MS } from './app-outage.ts';
import { escape, renderNotFoundPage } from './shells.ts';

/** The response header that marks this server's "app is down" answer. */
export const APP_DOWN_HEADER = 'x-cw-app-down';

/** How often the page asks whether the app is back. */
const POLL_MS = 3000;

/** How often the page reloads itself when it sits in the mock frame. */
const FRAMED_RELOAD_MS = 5000;

export interface AppWaitingModel {
  /** The app's name as the reader knows it: its title, else its doc id. */
  app: string;
  /** The board the app is filed on. */
  boardHref: string;
  /** Where "Ask again" posts. */
  askUrl: string;
  outage: OutageView;
  /** The display name of the agent told, when there was one. */
  askedName?: string;
  /** This server's clock when the page was rendered. */
  now: number;
}

/** `HH:MM` on the server's clock — the page rewrites it in the reader's. */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** JSON that is safe inside a `<script>` element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function whoAsked(m: AppWaitingModel): string {
  const name = m.askedName ? `<b>${escape(m.askedName)}</b>` : '';
  if (m.outage.addressedAs === 'attacher') {
    return `We asked ${name}, the agent that attached it, to start it again.`;
  }
  if (m.outage.addressedAs === 'lead') {
    return `No agent is recorded for this app, so we asked ${name}, who leads this board, to start it.`;
  }
  return 'No agent is recorded for this app and the board has no lead, so nobody was asked to start it.';
}

export function renderAppWaiting(m: AppWaitingModel): string {
  const app = escape(m.app);
  const data = {
    app: m.app,
    name: m.askedName ?? null,
    askUrl: m.askUrl,
    since: m.outage.since,
    askedAt: m.outage.askedAt,
    askedAgainAt: m.outage.askedAgainAt ?? null,
    now: m.now,
    askAgainMs: ASK_AGAIN_MS,
    pollMs: POLL_MS,
    framedReloadMs: FRAMED_RELOAD_MS,
    downHeader: APP_DOWN_HEADER,
  };
  const button = m.askedName
    ? `<button type="button" class="ask-btn" id="cw-ask">Ask ${escape(m.askedName)} again</button>`
    : '';
  return renderNotFoundPage({
    title: `${m.app} is starting`,
    heading: `${m.app} is starting`,
    head: `\n    <style>${WAITING_CSS}</style>`,
    body: `      <div id="cw-wait" data-state="waiting">
      <p><span id="cw-since">${app} stopped answering at <time>${hhmm(m.outage.since)}</time>.</span>
        ${whoAsked(m)}</p>
      <p>Keep this page open. It opens ${app} by itself as soon as it answers.</p>
      <div class="wait-line" role="status" aria-live="polite">
        <span class="wait-dot" aria-hidden="true"></span>
        <p class="wait-text" id="cw-wait-text">Waiting for ${app} to answer.</p>
      </div>
      <div class="ask-row" id="cw-ask-row" data-hidden>${button}</div>
      <noscript><p>Refresh this page to check again.</p></noscript>
      <p class="quiet"><a href="${escape(m.boardHref)}">Back to the board</a>.</p>
      </div>
      <script type="application/json" id="cw-wait-data">${scriptJson(data)}</script>
      <script>${WAITING_SCRIPT}</script>`,
  });
}

const WAITING_CSS = `
      .wait-line {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 20px 0 16px;
        padding: 12px 14px;
        border: 1px solid var(--border, #d0d7de);
        border-radius: 8px;
        background: var(--bg-subtle, #f6f8fa);
        min-height: 48px;
        box-sizing: border-box;
      }
      /* One steady indicator. It changes colour with the state and never moves. */
      .wait-dot {
        flex: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent, #2e7dd7);
      }
      [data-state="stuck"] .wait-dot,
      [data-state="asked-again"] .wait-dot { background: var(--orange, #e8590c); }
      .notfound-body .wait-text { margin: 0; }
      /* The ask row holds its space in every state, so nothing below it moves
         when the button appears. */
      .ask-row {
        display: flex;
        align-items: center;
        min-height: 40px;
        margin: 0 0 16px;
      }
      .ask-row[data-hidden] { visibility: hidden; }
      .ask-btn {
        width: 15rem;
        max-width: 100%;
        min-height: 40px;
        padding: 8px 16px;
        border-radius: 6px;
        border: 1px solid var(--accent, #2e7dd7);
        background: var(--accent, #2e7dd7);
        color: #fff;
        font: inherit;
        line-height: 1.3;
        cursor: pointer;
      }
      .ask-btn[disabled] {
        background: transparent;
        color: var(--fg-muted, #6e7781);
        border-color: var(--border, #d0d7de);
        cursor: default;
      }
      @media (max-width: 600px) {
        body.notfound-body { padding: 32px 16px; }
        /* Room for the longest status line, so the button below never moves. */
        .wait-line { min-height: 74px; }
      }
    `;

/**
 * The page's clock and poll. Plain ES5-ish script: it runs before any bundle
 * and on whatever browser opened the link. `skew` maps the server's instants
 * onto the reader's clock, so "two minutes" and "Asked at" agree with the
 * server whatever the reader's clock says.
 */
const WAITING_SCRIPT = `
(function () {
  var d = JSON.parse(document.getElementById('cw-wait-data').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var skew = Date.now() - d.now;
  var serverNow = function () { return Date.now() - skew; };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var hhmm = function (t) { var x = new Date(t + skew); return pad(x.getHours()) + ':' + pad(x.getMinutes()); };
  var framed = window.top !== window.self;
  var askedAt = d.askedAt, againAt = d.askedAgainAt, busy = false, note = null;

  $('cw-since').querySelector('time').textContent = hhmm(d.since);

  function state() {
    if (!d.name) return 'waiting';
    if (serverNow() - askedAt >= d.askAgainMs) return 'stuck';
    return againAt === askedAt ? 'asked-again' : 'waiting';
  }

  function render() {
    var s = state();
    $('cw-wait').setAttribute('data-state', s);
    var text = $('cw-wait-text'), row = $('cw-ask-row'), btn = $('cw-ask');
    if (s === 'waiting') text.textContent = 'Waiting for ' + d.app + ' to answer.';
    else if (s === 'stuck') text.textContent = d.name + ' has not started it yet. Asked' + (againAt === askedAt ? ' again' : '') + ' at ' + hhmm(askedAt) + '.';
    else text.textContent = 'Asked ' + d.name + ' again at ' + hhmm(askedAt) + '. Still waiting.';
    if (note) text.textContent = note;
    if (!btn) return;
    if (s === 'waiting' || framed) row.setAttribute('data-hidden', '');
    else row.removeAttribute('data-hidden');
    btn.disabled = busy || s === 'asked-again';
    btn.textContent = (s === 'asked-again' ? 'Asked ' : 'Ask ') + d.name + ' again';
  }

  function poll() {
    fetch(location.href, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      var edge = r.status === 502 || r.status === 503 || r.status === 504 || r.status === 530;
      if (!r.headers.has(d.downHeader) && !edge) location.reload();
    }, function () {});
  }

  function ask() {
    if (busy) return;
    busy = true; note = null; render();
    fetch(d.askUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (x.r.ok && typeof x.b.askedAt === 'number') { askedAt = againAt = x.b.askedAt; }
        else if (x.r.status === 429 && typeof x.b.retryAt === 'number') { askedAt = x.b.retryAt - d.askAgainMs; }
        else if (x.b.error === 'app_answering') { poll(); }
        else note = 'Could not ask ' + d.name + ' again' + (x.b.error === 'sign_in_required' ? ': sign in first.' : '.');
      }, function () { note = 'Could not ask ' + d.name + ' again.'; })
      .then(function () { busy = false; render(); });
  }

  if ($('cw-ask')) $('cw-ask').addEventListener('click', ask);
  render();
  if (framed) { setTimeout(function () { location.reload(); }, d.framedReloadMs); return; }
  setInterval(function () { render(); poll(); }, d.pollMs);
})();
`;
