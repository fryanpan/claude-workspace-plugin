import { afterEach, describe, expect, it } from 'vitest';
import { type VoiceConnectDeps, mountVoiceConnect } from '../src/voice-page/voice-connect.ts';

/**
 * The voice page's "Connect an app" control: the owner mints a token for a
 * phone app, sees it once, copies it and the server URL, and revokes old
 * ones. Driven against a fake of the `/api/voice/tokens` routes, with an
 * injected clock.
 */

const NOW = 1_800_000_000_000;
const VALUE = 'vk1.harborlight-phone-id.secret-mac-riverbend';

interface Row {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

function server(status = 200, rows: Row[] = []) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetch: VoiceConnectDeps['fetch'] = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (status !== 200) return Response.json({ error: 'owner-only' }, { status });
    if (path === '/api/voice/tokens' && method === 'GET') return Response.json({ tokens: rows });
    if (path === '/api/voice/tokens' && method === 'POST') {
      const row = { id: 'harborlight-phone-id', label: body.label || 'Voice app', createdAt: NOW };
      rows.push(row);
      return Response.json({ ...row, token: VALUE }, { status: 201 });
    }
    const revoke = path.match(/^\/api\/voice\/tokens\/([^/]+)\/revoke$/);
    const hit = rows.find((r) => r.id === revoke?.[1]);
    if (hit && method === 'POST') {
      hit.revokedAt = NOW;
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return { fetch, calls, rows };
}

const copied: string[] = [];
function deps(fetch: VoiceConnectDeps['fetch'], origin = 'https://harborlight.example') {
  return { fetch, now: () => NOW, origin, copy: async (t: string) => void copied.push(t) };
}

/** Settles the fetch chain a click starts. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function slot(): HTMLElement {
  const el = document.createElement('span');
  document.body.append(el);
  return el;
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => q(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

afterEach(() => {
  document.body.replaceChildren();
  copied.length = 0;
});

describe('the Connect an app control', () => {
  it('is not there for anyone but the owner', async () => {
    const host = slot();
    const api = server(403);
    expect(await mountVoiceConnect(host, deps(api.fetch))).toBeNull();
    expect(host.childElementCount).toBe(0);
    expect(q('.voice-connect')).toBeNull();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('shows a minted token once, with the server URL to paste', async () => {
    const api = server();
    await mountVoiceConnect(slot(), deps(api.fetch));
    click('.voice-connect-open');
    expect(q('.voice-connect-url')?.textContent).toBe('https://harborlight.example/v1');
    const label = q<HTMLInputElement>('.voice-connect-label');
    if (label) label.value = 'Riverbend phone';
    click('.voice-connect-mint');
    await flush();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([
      { path: '/api/voice/tokens', method: 'POST', body: { label: 'Riverbend phone' } },
    ]);
    expect(q('.voice-connect-token-value')?.textContent).toBe(VALUE);
    click('.voice-connect-copy-token');
    click('.voice-connect-copy-url');
    await flush();
    expect(copied).toEqual([VALUE, 'https://harborlight.example/v1']);
    expect(q('.voice-connect-list')?.textContent).toContain('Riverbend phone');

    // Closed and opened again, the value is nowhere on the page.
    click('.voice-connect-close');
    click('.voice-connect-open');
    await flush();
    expect(document.body.innerHTML).not.toContain('secret-mac');
    expect(q('.voice-connect-list')?.textContent).toContain('Riverbend phone');
  });

  it('lists standing tokens by label and last use, and revokes on a second tap', async () => {
    const api = server(200, [
      {
        id: 'saltmarsh-tablet-id',
        label: 'Saltmarsh tablet',
        createdAt: 1,
        lastUsedAt: NOW - 300_000,
      },
      { id: 'bob-old-phone-id', label: 'Old phone', createdAt: 1 },
      { id: 'alice-gone-id', label: 'Gone', createdAt: 1, revokedAt: 2 },
    ]);
    await mountVoiceConnect(slot(), deps(api.fetch));
    click('.voice-connect-open');
    await flush();
    const rows = [...document.querySelectorAll('.voice-connect-row')].map((r) => r.textContent);
    expect(rows).toEqual(['Saltmarsh tabletused 5 min agoRevoke', 'Old phonenever usedRevoke']);

    const revoke = '.voice-connect-row[data-id="saltmarsh-tablet-id"] .voice-connect-revoke';
    click(revoke);
    await flush();
    expect(api.calls.some((c) => c.path.endsWith('/revoke'))).toBe(false);
    expect(q(revoke)?.textContent).toBe('Confirm');
    click(revoke);
    await flush();
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/voice/tokens/saltmarsh-tablet-id/revoke',
    ]);
    expect(q('.voice-connect-row[data-id="saltmarsh-tablet-id"]')).toBeNull();
  });

  it('says when this address is one a phone cannot reach', async () => {
    await mountVoiceConnect(slot(), deps(server().fetch, 'http://127.0.0.1:8788'));
    click('.voice-connect-open');
    expect(q('.voice-connect-url-note')?.textContent).toContain('address your phone');
  });
});
