/**
 * The coach on a page: it says where he is when the page opens and when he
 * acts, at most once a minute; a refused first ping stops it and opens no
 * stream; a moment draws one card, escaped, which leaves on an answer, on a
 * clear, or when its ten minutes are up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BEACON_EVERY_MS, MOMENT_TTL_MS, mountCoachCard } from '../src/coach-card.ts';

type Posted = { url: string; body: Record<string, unknown> };
let posted: Posted[];
let status: number;
let clock: number;

class FakeStream {
  static last: FakeStream | null = null;
  listeners: ((ev: MessageEvent) => void)[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeStream.last = this;
  }
  addEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(frame: unknown) {
    for (const fn of this.listeners) fn(new MessageEvent('coach', { data: JSON.stringify(frame) }));
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const card = () => document.querySelector('.coach-card-host')?.shadowRoot ?? null;
const MOMENT = {
  id: 'cm-aaaaaaaaaaaa',
  name: 'Saltmarsh',
  line: 'Hi, I’m noticing <b>hover</b> again. Back to the post?',
  goal: 'Hard work first',
};

function mount(extra: Partial<Parameters<typeof mountCoachCard>[0]> = {}) {
  return mountCoachCard({
    workspaceId: 'w-harbor',
    post: async (url, body) => {
      posted.push({ url, body: body as Record<string, unknown> });
      return status;
    },
    openStream: (url) => new FakeStream(url) as unknown as EventSource,
    now: () => clock,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  posted = [];
  status = 200;
  clock = 1_000_000;
  FakeStream.last = null;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('where he is', () => {
  it('pings on open with the board and doc, then at most once a minute while he acts', async () => {
    document.body.innerHTML = '<div id="pane"><main id="ed"><h2>Greys</h2><p>text</p></main></div>';
    const c = mount({ docId: 'd-tokens', root: document.getElementById('ed') as HTMLElement });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      url: '/coach/here',
      body: { workspaceId: 'w-harbor', docId: 'd-tokens', visible: true, heading: 'Greys' },
    });
    document.dispatchEvent(new Event('keydown'));
    expect(posted).toHaveLength(1);
    clock += BEACON_EVERY_MS;
    vi.advanceTimersByTime(BEACON_EVERY_MS);
    expect(posted).toHaveLength(2);
    clock += BEACON_EVERY_MS;
    vi.advanceTimersByTime(BEACON_EVERY_MS);
    expect(posted).toHaveLength(2);
    c.destroy();
  });

  it('a first ping answered 204 (not the owner) stops it: no stream, and no ping after', async () => {
    status = 204;
    mount();
    await flush();
    expect(FakeStream.last).toBeNull();
    clock += BEACON_EVERY_MS;
    document.dispatchEvent(new Event('keydown'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toHaveLength(1);
  });
});

describe('the card', () => {
  it('draws the moment escaped, and Not now answers it and takes it away', async () => {
    const c = mount();
    await flush();
    expect(FakeStream.last?.url).toBe('/coach/stream');
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: clock } });
    expect(card()?.querySelector('.cw-coach-who')?.textContent).toBe('Saltmarsh');
    expect(card()?.querySelector('.cw-coach-line')?.textContent).toBe(MOMENT.line);
    expect(card()?.querySelector('b')).toBeNull();
    card()?.querySelector<HTMLButtonElement>('[data-answer="not-now"]')?.click();
    await flush();
    expect(posted.at(-1)).toEqual({
      url: '/coach/moments/cm-aaaaaaaaaaaa/answer',
      body: { answer: 'not-now' },
    });
    expect(card()).toBeNull();
    c.destroy();
  });

  it('a failed answer keeps the card, with its buttons back', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: clock } });
    status = 0;
    card()?.querySelector<HTMLButtonElement>('[data-answer="thanks"]')?.click();
    await flush();
    expect(card()?.querySelector<HTMLButtonElement>('[data-answer="thanks"]')?.disabled).toBe(
      false,
    );
  });

  it('leaves on a clear for its own id, and when its ten minutes are up', async () => {
    mount();
    await flush();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: clock } });
    FakeStream.last?.emit({ type: 'clear', id: 'cm-bbbbbbbbbbbb' });
    expect(card()).not.toBeNull();
    FakeStream.last?.emit({ type: 'clear', id: MOMENT.id });
    expect(card()).toBeNull();
    FakeStream.last?.emit({
      type: 'moment',
      moment: { ...MOMENT, at: clock - MOMENT_TTL_MS + 1000 },
    });
    expect(card()).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(card()).toBeNull();
    FakeStream.last?.emit({ type: 'moment', moment: { ...MOMENT, at: clock - MOMENT_TTL_MS } });
    expect(card()).toBeNull();
  });
});
