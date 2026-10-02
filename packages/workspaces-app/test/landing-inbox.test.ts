/**
 * Incoming Messages on the front page, driven as Bryan drives it: a tap
 * opens a line and shows its text as text, `b` opens the snooze modal, a
 * choice posts the snooze. The markup is the shape `inbox/section.ts` draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snoozeChoices, startInbox } from '../src/landing-inbox.ts';

const LINE = (id: string, purpose: string) =>
  `<div class="inbox-row" data-row="${id}" data-channel="Email"><div class="inbox-line"><div class="inbox-swipe-under"></div><button type="button" class="board-review-row" aria-expanded="false"><span class="board-review-row-title">${purpose}</span></button><div class="inbox-line-acts"><button type="button" class="inbox-snooze-btn" data-act="snooze" aria-label="Snooze"></button></div></div></div>`;

const SECTION = `<section id="inbox" class="inbox-front"><div class="inbox-keys" hidden></div><div class="inbox-rows">${LINE('ib-aaaaaaaaaaaa', 'Wants a yes on the Saltmarsh dates')}${LINE('ib-bbbbbbbbbbbb', 'Asks about Thursday')}</div><div class="inbox-foot"><button type="button" class="inbox-keys-btn" aria-expanded="false">Keys (?)</button></div></section>`;

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let bodyReply: unknown;

beforeEach(() => {
  document.body.innerHTML = SECTION;
  calls = [];
  bodyReply = { body: 'Hold the 14th? <img src=x onerror="window.hit=1">', link: null };
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/body')) return new Response(JSON.stringify(bodyReply));
      if (url === '/') return new Response(`<html><body>${SECTION}</body></html>`);
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  startInbox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(check()).toBe(true);
};

describe('a tap', () => {
  it('opens the line and shows its message as text, never as markup', async () => {
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(
      () => document.querySelector('.inbox-msg')?.textContent?.startsWith('Hold') ?? false,
    );
    expect(calls[0]?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/body');
    expect(document.querySelector('.inbox-msg')?.textContent).toContain('<img src=x');
    expect(document.querySelector('.inbox-card img')).toBeNull();
    expect(document.querySelector('.inbox-row')?.classList.contains('inbox-row-open')).toBe(true);
  });

  it('shows the thread link only when it is one of the allowed schemes', async () => {
    bodyReply = { body: 'Hi', link: 'javascript:alert(1)' };
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(() => document.querySelector('.inbox-msg')?.textContent === 'Hi');
    expect(document.querySelector('.inbox-card a')).toBeNull();

    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    bodyReply = { body: 'Hi', link: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c30001' };
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(() => document.querySelector('.inbox-card a') !== null);
    const a = document.querySelector<HTMLAnchorElement>('.inbox-card a');
    expect(a?.textContent).toBe('Open in Email');
    expect(a?.rel).toBe('noopener noreferrer');
  });
});

describe('snooze', () => {
  it('`b` opens the modal on the cursor line, and a choice posts the snooze', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    const modal = document.querySelector('.inbox-modal');
    expect(modal?.textContent).toContain('Snooze until…');
    const before = Date.now();
    modal?.querySelector<HTMLButtonElement>('.inbox-modal-opt')?.click();
    await until(() => calls.some((c) => c.url.endsWith('/state')));
    const post = calls.find((c) => c.url.endsWith('/state'));
    expect(post?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/state');
    const sent = JSON.parse(String(post?.init?.body)) as { action: string; until: number };
    expect(sent.action).toBe('snooze');
    expect(sent.until).toBeGreaterThan(before);
    await until(() => document.querySelector('.inbox-toast') !== null);
    expect(document.querySelector('.inbox-modal')).toBeNull();
  });

  it('the hover clock opens the same modal', () => {
    document.querySelectorAll<HTMLButtonElement>('.inbox-snooze-btn')[1]?.click();
    expect(document.querySelector('.inbox-modal')?.getAttribute('aria-label')).toBe('Snooze until');
  });

  it('j moves the cursor and Escape closes the modal', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    const rows = document.querySelectorAll('.inbox-row');
    expect(rows[1]?.classList.contains('inbox-row-cursor')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.inbox-modal')).toBeNull();
  });
});

describe('snoozeChoices', () => {
  const labels = (d: Date) => snoozeChoices(d).map(([l]) => l);

  it('offers Gmail’s four on a weekday at noon, at the right local times', () => {
    const wed = new Date(2026, 8, 30, 12, 30);
    const out = snoozeChoices(wed);
    expect(out.map(([l]) => l)).toEqual(['Later today', 'Tomorrow', 'This weekend', 'Next week']);
    expect(out.map(([, d]) => [d.getDay(), d.getHours()])).toEqual([
      [3, 18],
      [4, 8],
      [6, 8],
      [1, 8],
    ]);
  });

  it('drops the evening once it is near, and the weekend on the weekend', () => {
    expect(labels(new Date(2026, 8, 30, 17, 30))).not.toContain('Later today');
    expect(labels(new Date(2026, 9, 3, 10, 0))).not.toContain('This weekend');
    const sunday = snoozeChoices(new Date(2026, 9, 4, 10, 0));
    expect(sunday.find(([l]) => l === 'Next week')?.[1].getDate()).toBe(5);
  });
});
