/**
 * The voice page lists an agent that starts listening while the page is
 * open: the server's `voice.changed` frame (`page-nudges.ts`) makes it re-read
 * `/api/voice/agents`, with no reload and no poll.
 *
 * The page boots itself on import, so the test lays out its markup and its
 * two network doors — fetch and EventSource — before importing it.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { VoiceBoardRow } from '../src/voice-page/voice-page-model.ts';

class FakeStream extends EventTarget {
  static opened: FakeStream[] = [];
  constructor(readonly url: string) {
    super();
    FakeStream.opened.push(this);
  }
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 0));
};

it('an agent that starts listening elsewhere appears on the open page', async () => {
  let boards: VoiceBoardRow[] = [{ id: 'w-hbl', name: 'Harborlight', agents: [] }];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      reads.push(String(url));
      if (String(url) === '/api/voice/agents') return Response.json({ boards });
      return new Response('{}', { status: 404 });
    }),
  );
  vi.stubGlobal('EventSource', FakeStream);
  document.body.innerHTML = `
    <p id="voice-line"></p>
    <button id="voice-talk"></button>
    <div id="voice-agents"></div>`;
  await import('../src/voice-page/voice-app.ts');
  const list = document.getElementById('voice-agents') as HTMLElement;
  await until(() => list.textContent?.includes('Harborlight') === true);
  expect(list.querySelectorAll('.voice-agent')).toHaveLength(0);
  expect(FakeStream.opened.map((s) => s.url)).toEqual(['/api/voice/events:stream']);

  boards = [
    {
      id: 'w-hbl',
      name: 'Harborlight',
      agents: [{ agentId: 'riverbend', name: 'Riverbend', listening: true, lead: false }],
    },
  ];
  const before = reads.filter((u) => u === '/api/voice/agents').length;
  FakeStream.opened[0]?.dispatchEvent(new Event('voice.changed'));
  await until(() => list.querySelectorAll('.voice-agent').length > 0);
  expect(reads.filter((u) => u === '/api/voice/agents')).toHaveLength(before + 1);
  expect(list.querySelector('.voice-agent-name')?.textContent).toBe('Riverbend');
  expect(list.querySelector('.voice-agent-state')?.textContent).toBe('listening');
});
