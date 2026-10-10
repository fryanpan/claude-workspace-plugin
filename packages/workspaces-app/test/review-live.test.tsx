/**
 * The cross-board review (`/review`) stays live: an ask filed or answered on
 * any board reaches an open walk within a second. A new ask joins the queue;
 * the card the reader is on stays where it is, and shows as closed when it
 * was answered elsewhere. Fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type WalkthroughHandlers,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import {
  type CrossEntry,
  type CrossReviewRow,
  asQueue,
  crossEntry,
} from '../src/reviews/cross-walk-model.ts';
import { mergeLiveQueue, startReviewLive } from '../src/reviews/review-live.ts';

const NOW = 1_700_000_000_000;

const row = (n: number, project = 'Riverbend'): CrossReviewRow => ({
  kind: 'task-review',
  workspaceId: `w-${project.toLowerCase()}`,
  project,
  key: `w-${project.toLowerCase()}:task-review:t-${n}:r-${n}`,
  taskId: `t-${n}`,
  reviewItemId: `r-${n}`,
  docId: '',
  threadId: '',
  title: `Ask ${n}`,
  ask: `Which gauge, ${n}?`,
  askedBy: 'Tides Agent',
  since: NOW - 60_000,
  review: { shape: 'decision', headline: `Which gauge, ${n}?`, detail: 'Two gauges disagree.' },
  size: 'easy',
  minutes: 1,
});
const entries = (rows: CrossReviewRow[]): CrossEntry[] =>
  rows.flatMap((r) => {
    const e = crossEntry(r, NOW);
    return e ? [e] : [];
  });
const keys = (list: CrossEntry[]) => list.map((e) => e.item.key);

describe('mergeLiveQueue', () => {
  const [a, b, c, d] = entries([row(1), row(2), row(3), row(4, 'Harborlight')]);

  it('lets a new ask join, and keeps the reader on their card', () => {
    const merged = mergeLiveQueue([a!, b!, c!], [a!, d!, b!, c!], b!.item.key);
    expect(keys(merged.entries)).toEqual(keys([a!, d!, b!, c!]));
    expect(merged.closedKey).toBeNull();
  });

  it('keeps a card answered elsewhere in its place, marked closed', () => {
    const merged = mergeLiveQueue([a!, b!, c!], [a!, c!], b!.item.key);
    expect(keys(merged.entries)).toEqual(keys([a!, b!, c!]));
    expect(merged.closedKey).toBe(b!.item.key);
  });

  it('keeps the closed card first when nothing before it is left', () => {
    const merged = mergeLiveQueue([a!, b!], [b!], a!.item.key);
    expect(keys(merged.entries)).toEqual(keys([a!, b!]));
    expect(merged.closedKey).toBe(a!.item.key);
  });
});

class FakeStream {
  url: string;
  private handlers = new Map<string, Array<(ev: { data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, fn: (ev: { data?: string }) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  fire(name: string, parts?: string[]) {
    const data = parts ? JSON.stringify({ event: name, parts }) : undefined;
    for (const fn of this.handlers.get(name) ?? []) fn({ data });
  }
  close() {}
}

describe('startReviewLive', () => {
  let stream: FakeStream;
  let stop: () => void = () => {};
  let reads: number;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    reads = 0;
    stop = startReviewLive(
      async () => {
        reads += 1;
      },
      {
        openStream: (url) => {
          stream = new FakeStream(url);
          return stream as unknown as EventSource;
        },
        debounceMs: 0,
      },
    );
  });
  afterEach(() => stop());

  it('re-reads the queue when a board changes, and not for the coach or the inbox', async () => {
    expect(stream.url).toBe('/landing/events:stream');
    stream.fire('landing.changed', ['coach', 'inbox']);
    await flush();
    expect(reads).toBe(0);
    stream.fire('landing.changed', ['boards']);
    await flush();
    expect(reads).toBe(1);
  });

  it('catches up once after the stream was down', async () => {
    stream.fire('open');
    await flush();
    expect(reads).toBe(0);
    stream.fire('error');
    stream.fire('open');
    await flush();
    expect(reads).toBe(1);
  });
});

describe('a card answered elsewhere', () => {
  let root: HTMLElement;
  let dispose: () => void = () => {};
  const handlers: WalkthroughHandlers = {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    dispose();
    document.body.replaceChildren();
  });

  it('shows as closed, with no way left to answer it', () => {
    const list = entries([row(1), row(2)]);
    walkthroughData.value = {
      queue: asQueue(list),
      index: 0,
      progress: { cleared: 0, last: null },
      now: NOW,
      handlers,
      secretsGate: 'open',
      chrome: {
        backLabel: '‹ Back to Workspaces',
        heading: 'Workspace: Riverbend',
        doneLabel: 'Back to Workspaces',
        tally: false,
        closed: true,
      },
    };
    dispose = mountWalkthroughIsland(root);
    expect(root.querySelector('.board-walk-title')?.textContent).toBe('Which gauge, 1?');
    expect(root.textContent).toContain('Answered or withdrawn elsewhere');
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.board-walk-stepper, .board-walk-head')).not.toBeNull();
  });
});
