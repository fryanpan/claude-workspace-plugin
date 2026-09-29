/**
 * A reader who leaves a page mid-voice-note loses no words.
 *
 * Through the real server and its `/voice` socket, for a served mock and a
 * markdown doc. The test plays the page: it opens the socket, streams audio,
 * posts the notes it is sent as a page would, and then goes — a close frame
 * (a link followed) or no close frame at all (the browser quit). What is
 * asserted is the doc's threads afterwards: every word said is in a comment,
 * and a note that kept growing on one topic is one comment.
 *
 * The engine is the mock one and no tidier is configured, so nothing here
 * reaches the network and the words land as said. All fixtures are
 * synthetic — the Riverbend register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

setDefaultTimeout(30_000);

const AUTHOR = { id: 'known-riverbend', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const ANCHOR = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Save',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
};
/** One 20ms frame of PCM16 at 16kHz; the mock engine reveals a word per frame. */
const CHUNK = new Uint8Array(640);

type Frame = { type: string; [k: string]: unknown };

describe('leaving a page mid-voice-note', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let WS = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-leave-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceKeepGraceMs: 0,
      // Each session opens a fresh run of this script.
      transcription: createMockTranscriptionEngine([
        { words: ['the', 'save', 'button', 'hides'] },
        { words: ['behind', 'the', 'footer', 'on', 'narrow', 'screens'] },
      ]),
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

  const createDoc = async (name: string, type: 'markdown' | 'mockup'): Promise<string> => {
    const file = join(dataDir, `${name}.${type === 'mockup' ? 'html' : 'md'}`);
    writeFileSync(
      file,
      type === 'mockup'
        ? '<!doctype html><html><body><button>Save</button></body></html>'
        : `# ${name}\n\nThe Save button.\n`,
    );
    const res = await post(`/workspaces/${WS}/docs`, { docId: name, type, sourceUrl: file });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  /** The page's half: a socket that has started and heard `ready`. */
  const openPage = async (docId: string, query = '') => {
    const ws = new WebSocket(`${wsBase}/workspaces/${WS}/docs/${docId}/voice${query}`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string) as Frame));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('voice socket refused')));
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        targets: [{ i: 0, tag: 'button', text: 'Save' }],
        author: AUTHOR,
      }),
    );
    await waitFor(() => frames.find((f) => f.type === 'ready'), { describe: 'ready' });
    const speak = (n: number) => {
      for (let i = 0; i < n; i++) ws.send(CHUNK);
    };
    return { ws, frames, speak };
  };

  /** What the page does with a note it is sent: posts it as a thread. */
  const postNote = async (docId: string, note: Frame) => {
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: AUTHOR,
      text: note.text,
      anchor: ANCHOR,
      voice: { clip: note.clip, raw: note.raw },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { thread } = (await res.json()) as { thread: Thread };
    return { threadId: thread.id, commentId: thread.comments[0]?.id ?? '' };
  };

  const voiceThreads = (docId: string): Thread[] =>
    handle.docStore.listThreads(docId).filter((t) => t.comments.some((c) => c.voice));

  it('a mock left by a link mid-sentence keeps every word said, as a comment', async () => {
    const docId = await createDoc('riverbend-mock', 'mockup');
    // Opened as a served mock's frame opens it: relayed, and marked so.
    const page = await openPage(docId, '?cw-via=mock-frame');
    // Three words of a sentence, none settled: no note exists yet anywhere.
    page.speak(3);
    await waitFor(
      () => page.frames.find((f) => f.type === 'heard' && f.text === 'the save button'),
      {
        describe: 'the words heard',
      },
    );
    expect(page.frames.filter((f) => f.type === 'comment')).toEqual([]);
    page.ws.close(1001, 'going away');

    const [thread] = await waitFor(() => voiceThreads(docId)[0] && voiceThreads(docId), {
      describe: 'a kept comment',
    });
    expect(voiceThreads(docId)).toHaveLength(1);
    const c = thread?.comments[0];
    expect(c?.text).toBe('the save button');
    expect(c?.author).toMatchObject({ id: AUTHOR.id, name: AUTHOR.name });
    expect(c?.via).toBe('mock-frame');
    expect(c?.voice?.clip).toStartWith(
      `/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav#t=`,
    );
  });

  it('a doc whose browser quits mid-note keeps it as ONE comment holding everything said', async () => {
    const docId = await createDoc('harborlight-doc', 'markdown');
    const page = await openPage(docId);
    // A whole sentence and the frame that settles it; the pause makes it a note.
    page.speak(5);
    const first = await waitFor(() => page.frames.find((f) => f.type === 'comment'), {
      describe: 'the first note',
    });
    const posted = await postNote(docId, first);
    page.ws.send(JSON.stringify({ type: 'posted', key: first.key, threadId: posted.threadId }));
    // The same topic goes on, and the browser is gone before the next pause.
    page.speak(4);
    await waitFor(
      () => page.frames.find((f) => f.type === 'heard' && String(f.pending).includes('footer on')),
      { describe: 'the next words heard' },
    );
    // No close frame: the TCP connection just ends, as when a browser quits.
    (page.ws as unknown as { terminate(): void }).terminate();

    await waitFor(() => voiceThreads(docId)[0]?.comments[0]?.text.includes('footer on'), {
      describe: 'the note grown with the words said after it was posted',
    });
    const threads = voiceThreads(docId);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(posted.threadId);
    expect(threads[0]?.comments).toHaveLength(1);
    expect(threads[0]?.comments[0]?.text).toBe('the save button hides behind the footer on');
  });

  it('a note the page posted but never said so before it went is found, not written twice', async () => {
    const docId = await createDoc('saltmarsh-doc', 'markdown');
    const page = await openPage(docId);
    page.speak(5);
    const first = await waitFor(() => page.frames.find((f) => f.type === 'comment'), {
      describe: 'the first note',
    });
    // The create landed; the page went before it could send `posted`.
    const posted = await postNote(docId, first);
    page.speak(2);
    await waitFor(
      () => page.frames.find((f) => f.type === 'heard' && String(f.pending).includes('behind the')),
      {
        describe: 'the next words heard',
      },
    );
    page.ws.close(1001, 'going away');

    await waitFor(() => voiceThreads(docId)[0]?.comments[0]?.text.includes('behind'), {
      describe: 'the posted note grown',
    });
    const threads = voiceThreads(docId);
    expect(threads.map((t) => t.id)).toEqual([posted.threadId]);
    expect(threads[0]?.comments[0]?.text).toBe('the save button hides behind the');
  });
});
