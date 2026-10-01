/**
 * Answering the one clarifying question edits the note it is about: the doc
 * keeps the same number of comments, the note's words change, and an answer
 * about where the note belongs moves its anchor.
 *
 * Through the real server and its `/voice` socket. The test plays the page as
 * `VoiceSession` does (`widget/src/voice/voice-session.ts`): the first frame
 * for a key creates its thread, and a later one re-anchors it when its element
 * changed and edits its words when they changed. The engine is the mock one
 * and the tidier a fake, so nothing reaches the network. All fixtures are
 * synthetic — the Riverbend register.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Anchor, Thread } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

setDefaultTimeout(30_000);

const AUTHOR = { id: 'known-riverbend', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const CHUNK = new Uint8Array(640);

/** The page's half of the catalog: two Save buttons, one in each bar. */
const TARGETS = [
  { i: 0, tag: 'header', text: 'Riverbend' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 2, tag: 'footer', text: 'Harborlight' },
  { i: 3, tag: 'button', text: 'Save', parent: 2 },
];

const anchorFor = (target: number | null): Anchor =>
  target === null
    ? { kind: 'subject' }
    : {
        kind: 'element',
        snippet: { text: 'Save' },
        fingerprint: {
          tag: 'BUTTON',
          stableAttrs: {},
          classes: [],
          text: 'Save',
          path:
            target === 1 ? 'BUTTON[0] > HEADER[0] > BODY[0]' : 'BUTTON[0] > FOOTER[0] > BODY[0]',
          dataAttrs: {},
        },
      };

type Frame = { type: string; [k: string]: unknown };

/** The tidier: each session's one tick is answered from this queue. */
const replies: string[] = [];

describe('a clarifying answer edits the original note', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let WS = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-followup-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine([
        { words: ['this', 'one', 'should', 'pop', 'more'] },
      ]),
      voiceFeedbackTidy: async () => ({ text: replies.shift() ?? '{"comments":[]}' }),
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const createMock = async (name: string): Promise<string> => {
    const file = join(dataDir, `${name}.html`);
    writeFileSync(
      file,
      '<!doctype html><html><body><header>Riverbend <button>Save</button></header>' +
        '<footer>Harborlight <button>Save</button></footer></body></html>',
    );
    const res = await post(`/workspaces/${WS}/docs`, {
      docId: name,
      type: 'mockup',
      sourceUrl: file,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  /**
   * The page: a started socket, and every comment frame kept in step with a
   * thread as `VoiceSession.push` keeps it — one write chain, so a frame's
   * edit never overtakes the create before it.
   */
  const openPage = async (docId: string) => {
    const ws = new WebSocket(`${wsBase}/workspaces/${WS}/docs/${docId}/voice`);
    const frames: Frame[] = [];
    const threads = `/workspaces/${WS}/docs/${docId}/threads`;
    const posted = new Map<
      string,
      { threadId: string; commentId: string; text: string; target: unknown }
    >();
    let chain = Promise.resolve();
    const sync = async (f: Frame) => {
      const was = posted.get(String(f.key));
      const voice = { clip: f.clip, raw: f.raw };
      if (!was) {
        const res = await post(threads, {
          author: AUTHOR,
          text: f.text,
          anchor: anchorFor(f.target as number | null),
          voice,
        });
        expect(res.status, await res.clone().text()).toBe(200);
        const { thread } = (await res.json()) as { thread: Thread };
        const commentId = thread.comments[0]?.id ?? '';
        posted.set(String(f.key), {
          threadId: thread.id,
          commentId,
          text: String(f.text),
          target: f.target,
        });
        ws.send(JSON.stringify({ type: 'posted', key: f.key, threadId: thread.id }));
        return;
      }
      if (was.target !== f.target) {
        const res = await post(`${threads}/${was.threadId}/reanchor`, {
          anchor: anchorFor(f.target as number | null),
        });
        expect(res.status, await res.clone().text()).toBe(200);
        was.target = f.target;
      }
      if (was.text !== f.text) {
        const res = await post(`${threads}/${was.threadId}/edit-comment`, {
          author: AUTHOR,
          commentId: was.commentId,
          text: f.text,
          voice,
        });
        expect(res.status, await res.clone().text()).toBe(200);
        was.text = String(f.text);
      }
    };
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const f = JSON.parse(ev.data) as Frame;
      frames.push(f);
      if (f.type === 'comment') chain = chain.then(() => sync(f));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('voice socket refused')));
    });
    ws.send(
      JSON.stringify({ type: 'start', sampleRate: 16_000, targets: TARGETS, author: AUTHOR }),
    );
    await waitFor(() => frames.find((f) => f.type === 'ready'), { describe: 'ready' });
    return {
      ws,
      frames,
      settled: () => chain,
      speak: (n: number) => {
        for (let i = 0; i < n; i++) ws.send(CHUNK);
      },
    };
  };

  const voiceComments = (docId: string) =>
    handle.docStore
      .listThreads(docId)
      .flatMap((t) => t.comments.filter((c) => c.voice).map((c) => ({ thread: t, c })));

  it('an answer about the element moves the same comment to it', async () => {
    const docId = await createMock('riverbend-which');
    replies.push(
      JSON.stringify({
        comments: [
          {
            text: 'This Save button should stand out more.',
            element: 'e1',
            ask: {
              question: 'Which Save button?',
              choices: [
                { label: 'Save in the header', element: 'e1' },
                { label: 'Save in the footer', element: 'e3' },
              ],
            },
          },
        ],
      }),
    );
    const page = await openPage(docId);
    page.speak(6);
    const ask = await waitFor(() => page.frames.find((f) => f.type === 'ask' && f.question), {
      describe: 'the question',
    });
    await waitFor(() => voiceComments(docId).length === 1, { describe: 'the note written' });
    const before = voiceComments(docId)[0];
    expect(before?.thread.anchor).toEqual(anchorFor(1));

    page.ws.send(JSON.stringify({ type: 'answer', key: ask.key, choice: 1 }));
    await waitFor(
      () => JSON.stringify(voiceComments(docId)[0]?.thread.anchor) === JSON.stringify(anchorFor(3)),
      { describe: 'the note moved to the footer button' },
    );
    await page.settled();
    const after = voiceComments(docId);
    expect(after, 'the comment count is unchanged').toHaveLength(1);
    expect(after[0]?.thread.id).toBe(before?.thread.id ?? '');
    expect(after[0]?.c.id).toBe(before?.c.id ?? '');
    page.ws.close();
  });

  it('an answer about the meaning rewrites the same comment', async () => {
    const docId = await createMock('riverbend-pop');
    replies.push(
      JSON.stringify({
        comments: [
          {
            text: 'This Save button should pop more.',
            element: 'e1',
            ask: {
              question: 'Bigger, or a stronger colour?',
              choices: [
                { label: 'Bigger', text: 'Make the header Save button bigger.' },
                {
                  label: 'Stronger colour',
                  text: 'Give the header Save button a stronger colour.',
                },
              ],
            },
          },
        ],
      }),
    );
    const page = await openPage(docId);
    page.speak(6);
    const ask = await waitFor(() => page.frames.find((f) => f.type === 'ask' && f.question), {
      describe: 'the question',
    });
    expect(ask.about).toBe('meaning');
    await waitFor(() => voiceComments(docId).length === 1, { describe: 'the note written' });
    const before = voiceComments(docId)[0];
    expect(before?.c.text).toBe('This Save button should pop more.');

    page.ws.send(JSON.stringify({ type: 'answer', key: ask.key, choice: 1 }));
    await waitFor(
      () => voiceComments(docId)[0]?.c.text === 'Give the header Save button a stronger colour.',
      { describe: 'the note rewritten' },
    );
    await page.settled();
    const after = voiceComments(docId);
    expect(after, 'the comment count is unchanged').toHaveLength(1);
    expect(after[0]?.c.id).toBe(before?.c.id ?? '');
    expect(after[0]?.thread.anchor, 'a meaning answer leaves the anchor').toEqual(anchorFor(1));
    page.ws.close();
  });
});
