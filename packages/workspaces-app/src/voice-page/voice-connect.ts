/**
 * "Connect an app" on the voice page: the owner mints a voice API token for a
 * phone app such as Conduit, copies it and the server URL, and revokes old
 * ones. The routes are `/api/voice/tokens` (`routes/voice-api.ts`); the setup
 * steps are `docs/architecture/voice-conversation-api.md`.
 *
 * The control appears only when the token list answers, so a share visitor
 * or a signed-in person who is not the owner never sees it; the server's
 * refusal is the gate, this is only its reflection.
 *
 * A minted value is shown once. It lives in this module's `shown` and in the
 * one element that displays it, and both are cleared when the panel closes,
 * when another token is minted, and when any token is revoked. The server
 * never answers it again.
 *
 * Calm and still: the panel keeps one size whatever it shows. The token box
 * holds its height whether empty or full, the list scrolls inside a fixed
 * height, and Revoke keeps its width when it asks to be confirmed.
 */

export interface VoiceConnectDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** This page's origin; the server URL is this plus `/v1`. */
  origin: string;
  copy: (text: string) => Promise<void>;
}

interface TokenRow {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

/** "used 5 min ago", from the injected clock. */
export function lastUsedText(lastUsedAt: number | undefined, now: number): string {
  if (lastUsedAt === undefined) return 'never used';
  const min = Math.max(0, Math.round((now - lastUsedAt) / 60_000));
  if (min < 1) return 'used just now';
  if (min < 60) return `used ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `used ${h} h ago`;
  return `used ${Math.round(h / 24)} days ago`;
}

/** An address only this machine can open: a phone needs another one. */
function loopback(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
  } catch {
    return true;
  }
}

async function listTokens(deps: VoiceConnectDeps): Promise<TokenRow[] | null> {
  try {
    const res = await deps.fetch('/api/voice/tokens');
    if (!res.ok) return null;
    const body = (await res.json()) as { tokens?: TokenRow[] };
    return body.tokens ?? [];
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Mounts the opener into `slot` and the panel onto the body, or nothing at
 * all when the token list is refused. Null then.
 */
export async function mountVoiceConnect(
  slot: HTMLElement,
  deps: VoiceConnectDeps,
): Promise<{ open: () => void; close: () => void } | null> {
  const first = await listTokens(deps);
  if (first === null) return null;
  let rows = first;
  let shown: string | null = null;
  let confirming: string | null = null;
  /** Bumped on every close, so a mint that lands after one is not shown. */
  let opening = 0;
  const url = `${deps.origin}/v1`;

  const opener = el('button', 'voice-connect-open', 'Connect an app');
  opener.type = 'button';
  slot.append(opener);

  const panel = el('div', 'voice-connect');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Connect an app');
  panel.setAttribute('aria-modal', 'true');
  // Focus lands on the panel itself, not the name field, so opening it on
  // an iPad does not raise the keyboard.
  panel.tabIndex = -1;
  panel.hidden = true;

  const head = el('div', 'voice-connect-head');
  const title = el('h2', 'voice-connect-title', 'Connect an app');
  const close = el('button', 'voice-connect-close', 'Done');
  close.type = 'button';
  head.append(title, close);

  const urlRow = el('div', 'voice-connect-field');
  const urlName = el('span', 'voice-connect-name', 'Server URL');
  const urlValue = el('code', 'voice-connect-url', url);
  const copyUrl = el('button', 'voice-connect-copy-url', 'Copy');
  copyUrl.type = 'button';
  urlRow.append(urlName, urlValue, copyUrl);
  const urlNote = el(
    'p',
    'voice-connect-url-note',
    loopback(deps.origin)
      ? 'Open this page at the address your phone uses to see the URL it needs.'
      : '',
  );

  const form = el('form', 'voice-connect-form');
  const label = el('input', 'voice-connect-label');
  label.type = 'text';
  label.maxLength = 80;
  label.placeholder = 'Name it, e.g. iPhone';
  label.setAttribute('aria-label', 'Token name');
  const mintBtn = el('button', 'voice-connect-mint', 'Make a token');
  mintBtn.type = 'submit';
  form.append(label, mintBtn);

  const tokenBox = el('div', 'voice-connect-token');
  const tokenValue = el('code', 'voice-connect-token-value');
  const copyToken = el('button', 'voice-connect-copy-token', 'Copy');
  copyToken.type = 'button';
  const tokenNote = el('p', 'voice-connect-token-note');
  tokenBox.append(tokenValue, copyToken, tokenNote);

  const listName = el('div', 'voice-connect-name', 'Tokens');
  const list = el('div', 'voice-connect-list');
  panel.append(head, urlRow, urlNote, form, tokenBox, listName, list);
  document.body.append(panel);

  const renderToken = (): void => {
    tokenValue.textContent = shown ?? '';
    copyToken.hidden = shown === null;
    tokenNote.textContent = shown
      ? 'Shown once. Paste it into the app as its API key now.'
      : 'A new token appears here once, to copy into the app.';
  };
  const forget = (): void => {
    shown = null;
    renderToken();
  };

  const renderList = (): void => {
    list.replaceChildren();
    const standing = rows.filter((r) => r.revokedAt === undefined);
    if (standing.length === 0) {
      list.append(el('p', 'voice-connect-empty', 'No tokens yet.'));
      return;
    }
    for (const r of standing) {
      const row = el('div', 'voice-connect-row');
      row.dataset.id = r.id;
      const revoke = el(
        'button',
        'voice-connect-revoke',
        confirming === r.id ? 'Confirm' : 'Revoke',
      );
      revoke.type = 'button';
      row.append(
        el('span', 'voice-connect-row-label', r.label),
        el('span', 'voice-connect-row-used', lastUsedText(r.lastUsedAt, deps.now())),
        revoke,
      );
      list.append(row);
    }
  };

  const refresh = async (): Promise<void> => {
    const fresh = await listTokens(deps);
    if (fresh) rows = fresh;
    renderList();
  };

  const post = (path: string, body: unknown): Promise<Response | null> =>
    deps
      .fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      .catch(() => null);

  const open = (): void => {
    panel.hidden = false;
    panel.focus();
    renderToken();
    renderList();
    void refresh();
  };
  const shut = (): void => {
    opening++;
    panel.hidden = true;
    opener.focus();
    confirming = null;
    forget();
  };

  opener.addEventListener('click', open);
  close.addEventListener('click', shut);
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') shut();
  });
  // The clipboard is missing off a secure origin and can refuse anywhere;
  // say which, in the line under the value, so nobody closes the panel
  // believing a one-time value was copied.
  const copyInto = (text: string, note: HTMLElement): void => {
    void Promise.resolve()
      .then(() => deps.copy(text))
      .then(
        () => {
          note.textContent = 'Copied.';
        },
        () => {
          note.textContent = 'Could not copy. Select it and copy it by hand.';
        },
      );
  };
  copyUrl.addEventListener('click', () => copyInto(url, urlNote));
  copyToken.addEventListener('click', () => {
    if (shown) copyInto(shown, tokenNote);
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    forget();
    mintBtn.disabled = true;
    const mine = opening;
    void post('/api/voice/tokens', { label: label.value.trim() }).then(async (res) => {
      mintBtn.disabled = false;
      if (!res || res.status !== 201) {
        tokenNote.textContent = 'The token could not be made. Try again.';
        return;
      }
      const minted = (await res.json()) as { id?: string; token?: string };
      if (mine !== opening) {
        // Closed before it landed: nobody saw the value, so nobody can use
        // it. Revoke it rather than leave a token standing that no app holds.
        if (minted.id) void post(`/api/voice/tokens/${encodeURIComponent(minted.id)}/revoke`, {});
        return;
      }
      shown = minted.token ?? null;
      label.value = '';
      renderToken();
      await refresh();
    });
  });
  list.addEventListener('click', (ev) => {
    const btn = (ev.target as Element | null)?.closest<HTMLElement>('.voice-connect-revoke');
    const id = btn?.closest<HTMLElement>('.voice-connect-row')?.dataset.id;
    if (!id) return;
    if (confirming !== id) {
      confirming = id;
      renderList();
      return;
    }
    confirming = null;
    forget();
    void post(`/api/voice/tokens/${encodeURIComponent(id)}/revoke`, {}).then(refresh);
  });

  renderToken();
  return { open, close: shut };
}
