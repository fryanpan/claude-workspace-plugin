/**
 * An open Home drops an item the moment it is taken back
 * (board-live-wiring.ts).
 *
 * A reader's Mark read on a digest's doc page, and a run's output item whose
 * files were all opened, both withdraw a ticket item. No task row records a
 * withdrawal, so the board's projection never moves and only the store's
 * `review_item.withdrawn` event can tell the page. Driven by booting the
 * board and reading what it fetched, never by reading its source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BoardBootEnv, bootBoard } from '../src/board/board-app.ts';
import {
  FakeEventSource,
  type FakeServer,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const WS = 'w-harbor';
const NOW = 1_700_000_000_000;

async function bootHome(): Promise<void> {
  const sockets = fakeSockets();
  document.body.innerHTML = '<div id="board-root"></div>';
  const env: BoardBootEnv = {
    document,
    location: fakeLocation(`https://board.test/workspaces/${WS}/home`),
    history: fakeHistory(),
    localStorage: fakeStorage({ 'feedback-user-name': 'Alice' }),
    window: new EventTarget(),
    connect: sockets.connect,
  };
  const running = bootBoard(env);
  await settle();
  if (sockets.opened.length > 0) sockets.first().sync();
  await running;
  await settle();
}

const queueReads = (): number =>
  server.calls.filter((c) => c.url.split('?')[0]?.endsWith(`/workspaces/${WS}/review-items`))
    .length;

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on(`/workspaces/${WS}`, {
    workspace: { id: WS, name: 'Harborlight', goals: [], createdAt: NOW },
  });
  server.on(`/workspaces/${WS}/agents`, { agents: [] });
  server.on(`/workspaces/${WS}/review-items`, { items: [] });
  server.on(`/workspaces/${WS}/events`, { events: [] });
  server.on(`/workspaces/${WS}/home`, {
    workspaceId: WS,
    lastReadAt: 0,
    since: NOW - 86_400_000,
    instructions: '',
    brief: { markdown: 'Nothing new.', generatedAt: NOW, source: 'deterministic' },
    generating: false,
  });
  server.on(`/workspaces/${WS}/settings`, {});
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('an open Home and a withdrawn item', () => {
  it('reads the queue again on review_item.withdrawn', async () => {
    await bootHome();
    const before = queueReads();
    expect(before).toBeGreaterThan(0);
    FakeEventSource.last().dispatchEvent(new Event('review_item.withdrawn'));
    await vi.waitFor(() => expect(queueReads()).toBe(before + 1));
  });

  it('CONTROL: an event Home does not read the queue on fetches no queue', async () => {
    await bootHome();
    const before = queueReads();
    FakeEventSource.last().dispatchEvent(new Event('agent.heartbeat'));
    await settle();
    expect(queueReads()).toBe(before);
  });
});
