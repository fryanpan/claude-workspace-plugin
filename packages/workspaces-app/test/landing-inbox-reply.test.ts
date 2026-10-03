/**
 * The reply box under an opened line, driven as Bryan drives it: `r` puts
 * the caret in it, Send posts his words and a nonce and nothing else, Texts
 * offer Messages, and a channel with no credential says so in place of Send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesLink } from '../src/landing-inbox-reply.ts';
import { startInbox } from '../src/landing-inbox.ts';

const LINE = (id: string, channel: string) =>
  `<div class="inbox-row" data-row="${id}" data-channel="${channel}" data-sender="Alice"><div class="inbox-line"><button type="button" class="board-review-row" aria-expanded="false"><span class="board-review-row-title">Wants a yes</span></button></div></div>`;
const SECTION = (lines: string) =>
  `<section id="inbox" class="inbox-front" tabindex="-1"><div class="inbox-rows">${lines}</div></section>`;
const SENT = `<div class="inbox-row inbox-cleared" data-row="ib-aaaaaaaaaaaa"><div class="board-review-row"><span class="board-review-row-title">Wants a yes</span><span class="board-review-row-sub">You replied on Email · clears at the next check</span></div></div>`;

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let bodyReply: Record<string, unknown>;
let replyAnswer: { status: number; body: unknown };
let page: string;

beforeEach(() => {
  page = SECTION(LINE('ib-aaaaaaaaaaaa', 'Email') + LINE('ib-bbbbbbbbbbbb', 'Email'));
  document.body.innerHTML = page;
  calls = [];
  bodyReply = { body: 'Hold the 14th?', link: null, reply: { kind: 'send' } };
  replyAnswer = {
    status: 200,
    body: { id: 'ib-aaaaaaaaaaaa', state: 'answered', channel: 'gmail' },
  };
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/body')) return new Response(JSON.stringify(bodyReply));
      if (url.endsWith('/reply')) {
        return new Response(JSON.stringify(replyAnswer.body), { status: replyAnswer.status });
      }
      if (url === '/') return new Response(`<html><body>${page}</body></html>`);
      return new Response('{}');
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
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
const box = () => document.querySelector<HTMLTextAreaElement>('.inbox-reply');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.inbox-card button')].find(
    (b) => b.textContent === label,
  );

describe('r and Send', () => {
  it('`r` opens the cursor line with the caret in its reply box', async () => {
    key('r');
    await until(() => box() !== null);
    expect(document.activeElement).toBe(box());
    expect(box()?.placeholder).toBe('Reply to Alice');
    expect(document.querySelector('.inbox-row')?.classList.contains('inbox-row-open')).toBe(true);
  });

  it('Send posts the words as typed and a nonce, nothing else, then redraws', async () => {
    key('r');
    await until(() => box() !== null);
    const b = box() as HTMLTextAreaElement;
    b.value = '  Yes, the 14th.\nThanks ';
    b.dispatchEvent(new Event('input'));
    page = SECTION(SENT + LINE('ib-bbbbbbbbbbbb', 'Email'));
    button('Send')?.click();
    await until(() => document.querySelector('.inbox-cleared') !== null);
    const post = calls.find((c) => c.url.endsWith('/reply'));
    expect(post?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/reply');
    const sent = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['nonce', 'text']);
    expect(sent.text).toBe('  Yes, the 14th.\nThanks ');
    expect(String(sent.nonce)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // The cursor moved past the answered line, which is not a stop.
    key('o');
    await until(() => document.querySelector('.inbox-row-open') !== null);
    expect(document.querySelector('.inbox-row-open')?.getAttribute('data-row')).toBe(
      'ib-bbbbbbbbbbbb',
    );
  });

  it('an empty box sends nothing', async () => {
    key('r');
    await until(() => box() !== null);
    button('Send')?.click();
    expect(calls.some((c) => c.url.endsWith('/reply'))).toBe(false);
    expect(document.querySelector('.inbox-toast')?.textContent).toContain('Type a reply first.');
  });

  it('a refusal shows its reason, keeps the draft, and the next tap uses a new nonce', async () => {
    replyAnswer = {
      status: 502,
      body: { error: 'send-failed', message: 'Could not send on Email.' },
    };
    key('r');
    await until(() => box() !== null);
    (box() as HTMLTextAreaElement).value = 'Yes';
    button('Send')?.click();
    await until(
      () =>
        document.querySelector('.inbox-card [role="status"]')?.textContent ===
        'Could not send on Email.',
    );
    expect(box()?.value).toBe('Yes');
    button('Send')?.click();
    await until(() => calls.filter((c) => c.url.endsWith('/reply')).length === 2);
    const [a, b] = calls
      .filter((c) => c.url.endsWith('/reply'))
      .map((c) => (JSON.parse(String(c.init?.body)) as { nonce: string }).nonce);
    expect(a).not.toBe(b);
  });

  it('a channel with no credential shows the server’s sentence in place of Send', async () => {
    bodyReply = {
      body: 'Hi',
      link: null,
      reply: { kind: 'unset', message: "Sending isn't set up for Email yet." },
    };
    key('o');
    await until(() => document.querySelector('.inbox-unset') !== null);
    expect(document.querySelector('.inbox-unset')?.textContent).toBe(
      "Sending isn't set up for Email yet.",
    );
    expect(button('Send')).toBeUndefined();
  });
});

describe('Texts', () => {
  it('a 1:1 text offers Open in Messages; a group text, Copy and open Messages', async () => {
    bodyReply = { body: 'Dinner at 7?', link: 'sms:+15550001111', reply: { kind: 'messages' } };
    key('o');
    await until(() => box() !== null);
    expect(button('Open in Messages')).toBeDefined();
    expect(document.querySelector('.inbox-card a')).toBeNull();
    key('u');
    bodyReply = { body: 'Banners?', link: null, reply: { kind: 'messages' } };
    key('o');
    await until(() => button('Copy and open Messages') !== undefined);
  });

  it('fills the reply into an sms: link built from the row’s own number only', () => {
    expect(messagesLink('sms:+15550001111', 'See you at 7 & bring it?')).toBe(
      'sms:+15550001111&body=See%20you%20at%207%20%26%20bring%20it%3F',
    );
    expect(messagesLink('imessage:+15550001111', 'x')).toBe('sms:+15550001111&body=x');
    expect(messagesLink(null, 'x')).toBeNull();
    expect(messagesLink('sms:+15550001111&body=evil', 'x')).toBeNull();
  });
});
