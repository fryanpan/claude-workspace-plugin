/**
 * Incoming Messages' two modals and its toast: the "Snooze until…" picker,
 * the key list behind `?`, and the 6s toast that carries an Undo.
 *
 * Both modals are one centred dialog over a scrim, appended inside the
 * section and fixed to the viewport, so opening one never changes the
 * section's height. A tap on the scrim closes either; the caller's Escape
 * does too (`landing-inbox.ts`).
 */

import { el } from './landing-inbox-reply.ts';

const EIGHT_AM = 8;

/** The keys `?` lists, in the order Gmail's own help gives them. */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['j / k', 'Next / previous message'],
  ['o or Enter', 'Open'],
  ['swipe right', 'Snooze (touch)'],
  ['u or Esc', 'Back to the list'],
  ['r', 'Reply'],
  ['b', 'Snooze'],
  ['e', 'Remove'],
  ['?', 'Show or hide these keys'],
];

export function closeModal(): void {
  document.querySelector('.inbox-modal-back')?.remove();
  for (const b of document.querySelectorAll('.inbox-snooze-btn[aria-expanded="true"]')) {
    b.setAttribute('aria-expanded', 'false');
  }
}

export const keysOpen = (): boolean => document.querySelector('.inbox-keys') !== null;

/** An empty dialog on its scrim, already on the page. */
function modal(host: HTMLElement, label: string, cls = ''): HTMLElement {
  closeModal();
  const back = el('div', 'inbox-modal-back');
  back.addEventListener('click', (ev) => {
    if (ev.target === back) closeModal();
  });
  const box = el('div', `inbox-modal ${cls}`.trim());
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', label);
  back.append(box);
  host.append(back);
  return box;
}

export function openKeys(host: HTMLElement): void {
  const box = modal(host, 'Keyboard shortcuts', 'inbox-keys');
  box.append(el('div', 'inbox-modal-title', 'Keyboard shortcuts'));
  const dl = el('dl');
  for (const [k, v] of KEYS) dl.append(el('dt', '', k), el('dd', '', v));
  box.append(dl, el('p', 'inbox-hint', 'Space stays the mic.'));
}

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

export const whenLabel = (d: Date): string =>
  d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function openSnoozePicker(host: HTMLElement, pick: (when: Date) => void): void {
  const box = modal(host, 'Snooze until');
  box.append(el('div', 'inbox-modal-title', 'Snooze until…'));
  for (const [label, when] of snoozeChoices()) {
    const b = el('button', 'inbox-modal-opt');
    b.type = 'button';
    b.append(el('span', '', label), el('span', 'inbox-modal-when', whenLabel(when)));
    b.addEventListener('click', () => pick(when));
    box.append(b);
  }
  box.append(el('div', 'inbox-modal-rule'));
  const other = el('button', 'inbox-modal-opt', 'Select date and time');
  other.type = 'button';
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
    if (!Number.isNaN(when.getTime())) pick(when);
  });
  other.addEventListener('click', () => {
    other.hidden = true;
    form.hidden = false;
    input.focus();
  });
  form.append(input, save);
  box.append(other, form);
  box.querySelector<HTMLButtonElement>('.inbox-modal-opt')?.focus();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, undo?: () => Promise<void>): void {
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
