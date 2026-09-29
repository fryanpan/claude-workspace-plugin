/**
 * The two pages a signed-in MEMBER gets where the owner would get the product:
 * the list of boards their email belongs to, at `/`, and the one refusal for
 * a board they were not given.
 *
 * Both are answered by the admission gate, not by a route, because both are
 * about a request the gate has scoped to a visitor and nothing downstream may
 * serve: the owner's landing page (unfiled docs, the review bar, the API
 * footer) is not a member's to read, and a refused path never reaches a
 * route at all.
 *
 * The list is built from the SAME predicate the gate admits with, so a board
 * it names always opens and a board it leaves out never does. Closed boards
 * leave it too, because the gate refuses them after the membership check.
 *
 * The refusal carries the signed-in address and nothing about the board. A
 * board that exists and one that does not answer the same bytes, so a guessed
 * id tells nobody which ids are real — the property the JSON refusals already
 * held, kept by rendering from the email alone.
 */
import { LANDING_REVIEW_CSS, agoText } from './landing-review.ts';
import type { BoardRole } from './share/board-role.ts';
import { HTML_SHELL_HEADERS, LANDING_CSS, escape } from './shells.ts';
import { type BoardWorkspace, isRetired } from './tasks.ts';

/**
 * Where "Use a different account" goes. Cloudflare answers this path at the
 * edge on every Access-fronted hostname and ends the Access session, so the
 * next visit asks which address to sign in with. It never reaches this server.
 */
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

/** One row of a member's list. */
export interface MemberBoardRow {
  id: string;
  name: string;
  role: BoardRole;
  lastActivityAt: number;
  retired: boolean;
}

/**
 * The boards a member may open, in the order the list shows them: live boards
 * before retired ones, then most recently active first, then by name.
 */
export function memberBoards(
  workspaces: readonly BoardWorkspace[],
  mayOpen: (workspaceId: string) => boolean,
  roleOf: (workspaceId: string) => BoardRole,
): MemberBoardRow[] {
  return workspaces
    .filter((w) => mayOpen(w.id))
    .map((w) => ({
      id: w.id,
      name: w.name,
      role: roleOf(w.id),
      lastActivityAt: w.lastBoardActivityAt ?? 0,
      retired: isRetired(w),
    }))
    .sort(
      (a, b) =>
        Number(a.retired) - Number(b.retired) ||
        b.lastActivityAt - a.lastActivityAt ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Is this a browser navigating, rather than a script calling the API? Only a
 * navigation gets a page; a `fetch()` keeps the JSON body it has always had,
 * because the client's own error handling reads it.
 */
export function wantsPage(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.get('sec-fetch-mode') === 'navigate') return true;
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/** What a member may do on a board, in words rather than the wire value. */
function roleWords(role: BoardRole): string {
  return role === 'owner' ? 'Can edit and share' : 'Can edit';
}

const MEMBER_CSS = `
.who{color:#6e7781;font-size:13px;margin:0 0 18px;display:flex;flex-wrap:wrap;gap:0 10px;align-items:center}
.who b{color:#1b1f23;font-weight:600}
.who a{display:inline-flex;align-items:center;min-height:44px}
.notice{border:1px solid #e3e6ea;border-radius:10px;padding:18px 16px;margin:18px 0}
.notice h2{font-size:18px;margin:0 0 6px;text-transform:none;letter-spacing:0;color:#1b1f23;display:block}
.notice p{margin:0 0 12px;color:#57606a;font-size:14px}
.actions{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.actions a{display:inline-flex;align-items:center;min-height:44px;font-size:14px}
.primary{font-weight:600;background:#2e7dd7;color:#fff !important;border-radius:99px;padding:0 16px}
.primary:hover{text-decoration:none;background:#2669b8}
`;

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<meta name="theme-color" content="#2e7dd7">
<style>${LANDING_CSS}${LANDING_REVIEW_CSS}${MEMBER_CSS}</style>
<h1>Workspaces</h1>
${body}`;
}

function whoLine(email: string): string {
  return `<div class="who"><span>Signed in as <b>${escape(email)}</b></span><a href="${ACCESS_LOGOUT_PATH}">Use a different account</a></div>`;
}

function renderRow(row: MemberBoardRow, now: number): string {
  const href = `/workspaces/${encodeURIComponent(row.id)}/home`;
  const when = row.lastActivityAt > 0 ? `updated ${agoText(row.lastActivityAt, now)}` : '';
  const retired = row.retired ? 'Retired' : '';
  const meta = [retired, when].filter(Boolean).join(' · ');
  return `<li class="grp grp-flex"><a class="grp-link" href="${escape(href)}">
    <div class="grp-row"><span class="grp-name">${escape(row.name)}</span><span class="badge">${escape(roleWords(row.role))}</span></div>
    ${meta ? `<div class="grp-summary"><span class="ago">${escape(meta)}</span></div>` : ''}
  </a></li>`;
}

/** `/` for a member: their boards, or a sentence saying there are none. */
export function renderMemberHome(
  email: string,
  rows: readonly MemberBoardRow[],
  now: number = Date.now(),
): string {
  if (rows.length === 0) {
    return page(
      'Workspaces',
      `${whoLine(email)}
<div class="notice"><h2>Nothing is shared with this address yet</h2>
<p>When someone shares a workspace with ${escape(email)}, it shows up here. If you were invited at a different address, sign in with that one.</p>
<div class="actions"><a class="primary" href="${ACCESS_LOGOUT_PATH}">Use a different account</a></div></div>`,
    );
  }
  return page(
    'Workspaces',
    `${whoLine(email)}
<div class="prio-label">Shared with you <span class="count">${rows.length}</span></div>
<ul>${rows.map((r) => renderRow(r, now)).join('')}</ul>`,
  );
}

/**
 * The refusal for a board this address was not given, or one that does not
 * exist. Built from the email and nothing else — see the module note.
 *
 * `listHref` is where "See your workspaces" goes, or null on a door with no
 * list, where the link would lead to this page again.
 */
export function renderNotAMember(email: string | null, listHref: string | null): string {
  const who = email ? whoLine(email) : '';
  const address = email ? `${escape(email)} can’t open this link.` : 'This link doesn’t open here.';
  const ask = email
    ? ` Ask whoever sent you the link to share it with ${escape(email)}.`
    : ' Ask whoever sent you the link to share it with you.';
  const list = listHref
    ? `<a class="primary" href="${escape(listHref)}">See your workspaces</a>`
    : '';
  return page(
    'No access · Workspaces',
    `${who}
<div class="notice"><h2>You don’t have access to this workspace</h2>
<p>${address} It may have been shared with a different address, or the owner hasn’t shared it yet.${ask}</p>
<div class="actions">${list}<a href="${ACCESS_LOGOUT_PATH}">Use a different account</a></div></div>`,
  );
}

export function memberHomeResponse(email: string, rows: readonly MemberBoardRow[]): Response {
  return new Response(renderMemberHome(email, rows), { headers: HTML_SHELL_HEADERS });
}

export function notAMemberResponse(email: string | null, listHref: string | null): Response {
  return new Response(renderNotAMember(email, listHref), {
    status: 403,
    headers: HTML_SHELL_HEADERS,
  });
}
