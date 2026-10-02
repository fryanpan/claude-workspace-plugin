/**
 * Incoming Messages on the front page: what a tap, a swipe and a key do.
 *
 * The server draws the section (`packages/server/src/inbox/section.ts`) and
 * this file only acts on it, per the approved round-3 mock:
 *
 *  - a tap opens a line, fetches its message text, and scrolls the line to
 *    the top of the screen;
 *  - a right swipe, the hover clock or `b` opens one "Snooze until…" modal;
 *  - Gmail's keys move a cursor and open lines.
 *
 * After any tap that changes a row, the section is re-read from `/` and
 * swapped in whole, so there is one renderer and the page never draws a
 * state the server does not hold. The message text is set with
 * `textContent` and never parsed as markup.
 */

const SECTION = '#inbox';
const EIGHT_AM = 8;
/** As `INBOX_VISIBLE_LINES` on the server. */
const VISIBLE_LINES = 5;

interface ViewState {
  open: string | null;
  cursor: string | null;
  expanded: boolean;
  showSnoozed: boolean;
  showKeys: boolean;
}

const state: ViewState = {
  open: null,
  cursor: null,
  expanded: false,
  showSnoozed: false,
  showKeys: false,
};

const section = (): HTMLElement | null => document.querySelector<HTMLElement>(SECTION);
const rowEl = (id: string): HTMLElement | null =>
  section()?.querySelector<HTMLElement>(`.inbox-row[data-row="${CSS.escape(id)}"]`) ?? null;
const openRows = (): HTMLElement[] =>
  [...(section()?.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row') ?? [])].filter(
    (r) => !r.hidden,
  );

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function post(id: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/inbox/rows/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-read the section from the server and put the view back as it was. */
async function refresh(): Promise<void> {
  try {
    const res = await fetch('/', { credentials: 'same-origin' });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector(SECTION);
    const here = section();
    if (!fresh || !here) return;
    here.replaceWith(document.importNode(fresh, true));
    applyView();
  } catch {
    // The page keeps what it showed; the next load corrects it.
  }
}

// ---------- the view: cursor, open line, folds ----------

function applyView(): void {
  const s = section();
  if (!s) return;
  for (const [n, r] of [...s.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row')].entries()) {
    r.hidden = !state.expanded && n >= VISIBLE_LINES;
  }
  const more = s.querySelector<HTMLButtonElement>('[data-more]');
  if (more) {
    more.dataset.label ??= more.textContent ?? '';
    more.textContent = state.expanded ? 'Show fewer' : more.dataset.label;
  }
  const fold = s.querySelector<HTMLElement>('.inbox-snoozed');
  const toggle = s.querySelector<HTMLButtonElement>('[data-snoozed-toggle]');
  if (fold && toggle) {
    fold.hidden = !state.showSnoozed;
    toggle.setAttribute('aria-expanded', String(state.showSnoozed));
    toggle.textContent =
      toggle.textContent?.replace(/^(Show|Hide)/, state.showSnoozed ? 'Hide' : 'Show') ?? '';
  }
  const keys = s.querySelector<HTMLElement>('.inbox-keys');
  if (keys) keys.hidden = !state.showKeys;
  s.querySelector('.inbox-keys-btn')?.setAttribute('aria-expanded', String(state.showKeys));
  if (state.open && !rowEl(state.open)?.closest('.inbox-rows')) state.open = null;
  for (const r of s.querySelectorAll<HTMLElement>('.inbox-rows > .inbox-row')) {
    const id = r.dataset.row ?? '';
    r.classList.toggle('inbox-row-cursor', id === state.cursor);
    const isOpen = id === state.open;
    r.classList.toggle('inbox-row-open', isOpen);
    r.querySelector('.board-review-row')?.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) r.querySelector('.inbox-card')?.remove();
    else if (!r.querySelector('.inbox-card')) void showCard(r, id);
  }
  localTimes(s);
}

/** Times the server wrote in its own zone, rewritten in the viewer's. */
function localTimes(root: HTMLElement): void {
  for (const t of root.querySelectorAll<HTMLTimeElement>('time[data-at]')) {
    const at = Number(t.dataset.at);
    if (!Number.isFinite(at)) continue;
    const d = new Date(at);
    t.dateTime = d.toISOString();
    t.textContent =
      t.dataset.clock !== undefined
        ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
}

async function showCard(row: HTMLElement, id: string): Promise<void> {
  const card = el('div', 'inbox-card');
  const msg = el('p', 'inbox-msg', 'Loading…');
  card.append(msg);
  row.append(card);
  row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  try {
    const res = await fetch(`/inbox/rows/${encodeURIComponent(id)}/body`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { body?: unknown; link?: unknown };
    msg.textContent = typeof data.body === 'string' ? data.body : '';
    const link = typeof data.link === 'string' ? data.link : null;
    if (link && /^(https:|sms:|imessage:)/.test(link)) {
      const acts = el('div', 'inbox-actions');
      const a = el('a', 'board-btn', `Open in ${row.dataset.channel ?? 'the app'}`);
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acts.append(a);
      card.append(acts);
    }
  } catch {
    msg.textContent = 'Could not load this message.';
  }
}

function toggleOpen(id: string): void {
  state.open = state.open === id ? null : id;
  state.cursor = id;
  closeModal();
  applyView();
}

// ---------- snooze: the modal, its times, the undo ----------

function at(days: number, hour: number, from = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Gmail's four choices, less the ones already past. */
export function snoozeChoices(now = new Date()): Array<[label: string, when: Date]> {
  const day = now.getDay();
  const out: Array<[string, Date]> = [];
  const evening = at(0, 18, now);
  if (evening.getTime() - now.getTime() > 60 * 60_000) out.push(['Later today', evening]);
  out.push(['Tomorrow', at(1, EIGHT_AM, now)]);
  if (day >= 1 && day <= 4) out.push(['This weekend', at(6 - day, EIGHT_AM, now)]);
  out.push(['Next week', at((8 - day) % 7 || 7, EIGHT_AM, now)]);
  return out;
}

const whenLabel = (d: Date): string =>
  d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function closeModal(): void {
  document.querySelector('.inbox-modal-back')?.remove();
  for (const b of document.querySelectorAll('.inbox-snooze-btn[aria-expanded="true"]')) {
    b.setAttribute('aria-expanded', 'false');
  }
}

function openSnooze(id: string): void {
  closeModal();
  state.cursor = id;
  applyView();
  rowEl(id)?.querySelector('.inbox-snooze-btn')?.setAttribute('aria-expanded', 'true');
  const back = el('div', 'inbox-modal-back');
  back.addEventListener('click', (ev) => {
    if (ev.target === back) closeModal();
  });
  const box = el('div', 'inbox-modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Snooze until');
  box.append(el('div', 'inbox-modal-title', 'Snooze until…'));
  for (const [label, when] of snoozeChoices()) {
    const b = el('button', 'inbox-modal-opt');
    b.type = 'button';
    b.append(el('span', '', label), el('span', 'inbox-modal-when', whenLabel(when)));
    b.addEventListener('click', () => void snooze(id, when));
    box.append(b);
  }
  box.append(el('div', 'inbox-modal-rule'));
  const pick = el('button', 'inbox-modal-opt', 'Select date and time');
  pick.type = 'button';
  const form = el('div', 'inbox-modal-pick');
  form.hidden = true;
  const input = el('input');
  input.type = 'datetime-local';
  const tomorrow = at(1, 9);
  input.value = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T09:00`;
  const save = el('button', 'board-btn', 'Save');
  save.type = 'button';
  save.addEventListener('click', () => {
    const when = new Date(input.value);
    if (!Number.isNaN(when.getTime())) void snooze(id, when);
  });
  pick.addEventListener('click', () => {
    pick.hidden = true;
    form.hidden = false;
    input.focus();
  });
  form.append(input, save);
  box.append(pick, form);
  back.append(box);
  section()?.append(back);
  box.querySelector<HTMLButtonElement>('.inbox-modal-opt')?.focus();
}

function moveCursorPast(id: string): void {
  const ids = openRows().map((r) => r.dataset.row ?? '');
  const i = ids.indexOf(id);
  state.cursor = ids[i + 1] ?? ids[i - 1] ?? null;
}

async function snooze(id: string, when: Date): Promise<void> {
  closeModal();
  if (!(await post(id, { action: 'snooze', until: when.getTime() }))) {
    toast('Could not snooze that message.');
    return;
  }
  moveCursorPast(id);
  if (state.open === id) state.open = null;
  await refresh();
  toast(`Snoozed until ${whenLabel(when)}.`, async () => {
    if (await post(id, { action: 'undo' })) await refresh();
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, undo?: () => Promise<void>): void {
  document.querySelector('.inbox-toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', 'inbox-toast');
  t.setAttribute('role', 'status');
  t.append(el('span', '', text));
  if (undo) {
    const b = el('button', '', 'Undo');
    b.type = 'button';
    b.addEventListener('click', () => {
      t.remove();
      void undo();
    });
    t.append(b);
  }
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 6000);
}

// ---------- the swipe ----------

/** Drag a line right past a third of its width (or 96px) and let go: the
 *  snooze modal opens. Shorter springs back; a vertical drag stays a scroll. */
function onPointerDown(ev: PointerEvent): void {
  if (ev.pointerType === 'mouse') return;
  const line = (ev.target as Element | null)?.closest<HTMLElement>('.inbox-line');
  const main = line?.querySelector<HTMLElement>('.board-review-row');
  const id = line?.closest<HTMLElement>('.inbox-row')?.dataset.row;
  if (!line || !main || !id) return;
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let dx = 0;
  let horiz: boolean | null = null;
  const reach = () => Math.min(96, line.offsetWidth / 3);
  const move = (e: PointerEvent) => {
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (horiz === null && Math.abs(mx) + Math.abs(my) > 8) horiz = Math.abs(mx) > Math.abs(my);
    if (!horiz) return;
    dx = Math.max(0, mx);
    main.style.transform = `translateX(${dx}px)`;
    line.classList.toggle('inbox-swiping', dx > 0);
    line.classList.toggle('inbox-swipe-armed', dx > reach());
  };
  const end = () => {
    line.removeEventListener('pointermove', move);
    line.removeEventListener('pointerup', end);
    line.removeEventListener('pointercancel', end);
    const armed = dx > reach();
    main.style.transform = '';
    line.classList.remove('inbox-swiping', 'inbox-swipe-armed');
    if (horiz && dx > 8) {
      // The tap that ends a drag is not an open.
      main.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
        },
        { capture: true, once: true },
      );
    }
    if (armed) openSnooze(id);
  };
  line.addEventListener('pointermove', move);
  line.addEventListener('pointerup', end);
  line.addEventListener('pointercancel', end);
}

// ---------- clicks and keys ----------

function onClick(ev: MouseEvent): void {
  const t = ev.target as Element | null;
  const s = section();
  if (!t || !s?.contains(t)) return;
  const row = t.closest<HTMLElement>('.inbox-row');
  const id = row?.dataset.row ?? '';
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'snooze' && id) openSnooze(id);
  else if (act === 'reopen' && id) {
    void post(id, { action: 'reopen' }).then((ok) => (ok ? refresh() : undefined));
  } else if (t.closest('[data-more]')) {
    state.expanded = !state.expanded;
    applyView();
  } else if (t.closest('[data-snoozed-toggle]')) {
    state.showSnoozed = !state.showSnoozed;
    applyView();
  } else if (t.closest('.inbox-keys-btn')) {
    state.showKeys = !state.showKeys;
    applyView();
  } else if (t.closest('.inbox-line > .board-review-row') && id) toggleOpen(id);
}

function step(delta: number): void {
  let ids = openRows().map((r) => r.dataset.row ?? '');
  let i = ids.indexOf(state.cursor ?? '');
  if (
    delta > 0 &&
    i === ids.length - 1 &&
    !state.expanded &&
    section()?.querySelector('[data-more]')
  ) {
    state.expanded = true;
    applyView();
    ids = openRows().map((r) => r.dataset.row ?? '');
  }
  i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta));
  state.cursor = ids[i] ?? null;
  applyView();
  if (state.cursor) rowEl(state.cursor)?.scrollIntoView({ block: 'nearest' });
}

function onKey(ev: KeyboardEvent): void {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || !section()) return;
  const t = ev.target as HTMLElement | null;
  if (
    t &&
    (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
  ) {
    if (ev.key === 'Escape') closeModal();
    return;
  }
  const k = ev.key;
  const cursor = state.cursor ?? openRows()[0]?.dataset.row ?? null;
  const onControl = t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement;
  if (k === 'j' || k === 'k') step(k === 'j' ? 1 : -1);
  else if ((k === 'o' || (k === 'Enter' && !onControl)) && cursor) {
    state.open = cursor;
    state.cursor = cursor;
    applyView();
  } else if (k === 'b' && cursor) openSnooze(cursor);
  else if (k === 'u' || k === 'Escape') {
    closeModal();
    state.open = null;
    state.showKeys = false;
    applyView();
  } else if (k === '?') {
    state.showKeys = !state.showKeys;
    applyView();
  } else return;
  ev.preventDefault();
}

let listening = false;

export function startInbox(): void {
  const s = section();
  if (!s) return;
  Object.assign(state, { open: null, expanded: false, showSnoozed: false, showKeys: false });
  state.cursor = openRows()[0]?.dataset.row ?? null;
  applyView();
  if (listening) return;
  listening = true;
  document.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKey);
}
