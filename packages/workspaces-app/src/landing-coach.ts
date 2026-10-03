/**
 * "This week" on the front page: what Edit, Save and the two answer buttons
 * do. The server draws the section (`packages/server/src/coach/section.ts`);
 * after a save or an answer the section is re-read from `/` and swapped in
 * whole, so the page never shows a state the server does not hold.
 *
 * "Plans changed" opens the editor once the answer is saved, because a
 * change of plan usually means the list is out of date.
 */

const SECTION = '#coach';

const section = (): HTMLElement | null => document.querySelector<HTMLElement>(SECTION);
const editor = (): HTMLFormElement | null =>
  section()?.querySelector<HTMLFormElement>('[data-coach-edit]') ?? null;

async function post(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
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

/** Times the server wrote in its own zone, rewritten in the viewer's. */
function localTimes(): void {
  for (const t of section()?.querySelectorAll<HTMLTimeElement>('time[data-at]') ?? []) {
    const at = Number(t.dataset.at);
    if (!Number.isFinite(at)) continue;
    t.dateTime = new Date(at).toISOString();
    t.textContent = new Date(at).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/', { credentials: 'same-origin' });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector(SECTION);
    const here = section();
    if (fresh && here) here.replaceWith(document.importNode(fresh, true));
    localTimes();
  } catch {
    // The page keeps what it showed; the next load corrects it.
  }
}

function openEditor(): void {
  const form = editor();
  if (!form) return;
  form.hidden = false;
  form.querySelector<HTMLInputElement>('input')?.focus();
}

function setBusy(scope: Element, busy: boolean): void {
  for (const b of scope.querySelectorAll<HTMLButtonElement>('button')) b.disabled = busy;
}

async function onClick(ev: MouseEvent): Promise<void> {
  const target = ev.target as Element | null;
  const btn = target?.closest<HTMLButtonElement>('button');
  if (!btn || !section()?.contains(btn)) return;
  if (btn.dataset.act === 'edit') return openEditor();
  if (btn.dataset.act === 'cancel') {
    const form = editor();
    if (form) {
      form.reset();
      form.hidden = true;
    }
    return;
  }
  const answer = btn.dataset.answer;
  const nudge = btn.closest<HTMLElement>('[data-nudge]');
  if (!answer || !nudge) return;
  setBusy(nudge, true);
  const ok = await post(`/coach/nudges/${encodeURIComponent(nudge.dataset.nudge ?? '')}/answer`, {
    answer,
  });
  if (!ok) return setBusy(nudge, false);
  await refresh();
  if (answer === 'plans-changed') openEditor();
}

async function onSubmit(ev: SubmitEvent): Promise<void> {
  const form = (ev.target as Element | null)?.closest<HTMLFormElement>('[data-coach-edit]');
  if (!form || !section()?.contains(form)) return;
  ev.preventDefault();
  const goals = [...form.querySelectorAll<HTMLInputElement>('input[name="goal"]')].map(
    (i) => i.value,
  );
  setBusy(form, true);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (await post('/coach/goals', { goals, timeZone })) await refresh();
  else setBusy(form, false);
}

/** Wire the section, when the page carries it. Listens on the document so a
 *  swapped-in section needs no re-wiring. */
export function startCoach(): void {
  if (!section()) return;
  localTimes();
  document.addEventListener('click', (ev) => void onClick(ev));
  document.addEventListener('submit', (ev) => void onSubmit(ev));
}
