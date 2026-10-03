/**
 * The reply box under an opened Incoming Messages line, per the approved
 * round-3 mock:
 *
 *  - Email and Slack get Send, which posts Bryan's words to
 *    `/inbox/rows/:id/reply`. The server picks the thread from the row; the
 *    page sends only the text and a nonce, so a lost answer can be retried
 *    without sending twice.
 *  - Texts get "Open in Messages" with the reply filled in, built here from
 *    the row's own number and never stored, or "Copy and open Messages" for
 *    a group text, which has no number.
 *  - A channel whose credential is missing shows the server's sentence in
 *    place of Send.
 *
 * A draft survives the section being redrawn, until it is sent.
 */

export type ReplyKind =
  | { kind: 'send' }
  | { kind: 'messages' }
  | { kind: 'unset'; message: string };

export interface ReplyHooks {
  /** The send went out: the caller redraws the section. */
  sent: (id: string, channel: string) => Promise<void>;
  toast: (text: string) => void;
}

const drafts = new Map<string, string>();
const nonces = new Map<string, string>();
const TEXT_NUMBER = /^(?:sms|imessage):(\+[1-9][0-9]{6,14})$/;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function replyKindOf(raw: unknown): ReplyKind | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (r?.kind === 'send' || r?.kind === 'messages') return { kind: r.kind };
  if (r?.kind === 'unset' && typeof r.message === 'string') {
    return { kind: 'unset', message: r.message };
  }
  return null;
}

/** One nonce per row until the server gives a definite answer to it. */
function nonceFor(id: string): string {
  let n = nonces.get(id);
  if (!n) {
    n = crypto.randomUUID().replace(/-/g, '');
    nonces.set(id, n);
  }
  return n;
}

/** The `sms:` link with Bryan's words filled in, for a 1:1 text. */
export function messagesLink(link: string | null, text: string): string | null {
  const number = link?.match(TEXT_NUMBER)?.[1];
  return number ? `sms:${number}&body=${encodeURIComponent(text)}` : null;
}

function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function send(
  id: string,
  box: HTMLTextAreaElement,
  btn: HTMLButtonElement,
  status: HTMLElement,
  hooks: ReplyHooks,
): Promise<void> {
  if (box.value.trim() === '') {
    box.focus();
    hooks.toast('Type a reply first.');
    return;
  }
  btn.disabled = true;
  status.textContent = 'Sending…';
  let res: Response;
  try {
    res = await fetch(`/inbox/rows/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: box.value, nonce: nonceFor(id) }),
    });
  } catch {
    // The answer was lost, not refused: the same nonce goes again next tap.
    btn.disabled = false;
    status.textContent = 'Could not reach the server. Try again.';
    return;
  }
  const data = (await res.json().catch(() => ({}))) as { message?: unknown; channel?: unknown };
  nonces.delete(id);
  if (res.ok) {
    drafts.delete(id);
    await hooks.sent(id, typeof data.channel === 'string' ? data.channel : '');
    return;
  }
  btn.disabled = false;
  status.textContent = typeof data.message === 'string' ? data.message : 'Could not send.';
}

function openMessages(link: string | null, box: HTMLTextAreaElement, hooks: ReplyHooks): void {
  const text = box.value;
  if (text.trim() === '') {
    box.focus();
    hooks.toast('Type a reply first.');
    return;
  }
  const filled = messagesLink(link, text);
  if (filled) {
    location.assign(filled);
    return;
  }
  void navigator.clipboard
    ?.writeText(text)
    .then(() => hooks.toast('Copied. Paste it in Messages.'))
    .catch(() => hooks.toast('Could not copy. Select the text and copy it.'));
  location.assign('sms:');
}

/** The box and its actions, appended to an opened line's card; returns the
 *  actions row so the caller can add the thread's own link to it. */
export function replyBox(
  card: HTMLElement,
  id: string,
  opts: { kind: ReplyKind; link: string | null; channel: string; sender: string; focus: boolean },
  hooks: ReplyHooks,
): HTMLElement {
  const box = el('textarea', 'inbox-reply');
  box.rows = 3;
  box.placeholder = opts.sender ? `Reply to ${opts.sender}` : 'Reply';
  box.setAttribute('aria-label', 'Reply');
  box.value = drafts.get(id) ?? '';
  box.addEventListener('input', () => drafts.set(id, box.value));
  const acts = el('div', 'inbox-actions');
  const status = el('span', 'inbox-hint');
  status.setAttribute('role', 'status');
  if (opts.kind.kind === 'send') {
    const btn = button('board-btn board-btn-ink', 'Send', () => {
      void send(id, box, btn, status, hooks);
    });
    status.textContent = `Sends as you on ${opts.channel}, in the same thread.`;
    acts.append(btn, status);
  } else if (opts.kind.kind === 'messages') {
    const label = TEXT_NUMBER.test(opts.link ?? '') ? 'Open in Messages' : 'Copy and open Messages';
    acts.append(
      button('board-btn board-btn-ink', label, () => openMessages(opts.link, box, hooks)),
    );
    status.textContent = 'You send it in Messages. The line clears at the next check.';
    acts.append(status);
  } else {
    acts.append(el('span', 'inbox-unset', opts.kind.message));
  }
  card.append(box, acts);
  if (opts.focus) box.focus();
  return acts;
}
