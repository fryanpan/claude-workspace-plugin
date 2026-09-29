/**
 * The notes of a voice page that went away, written by the server
 * (`voice-feedback-keep.ts`), over an in-memory thread store — and the relay
 * handing them over when a socket closes without a Stop.
 *
 * Nothing here reaches the network. All fixtures are synthetic — the
 * Riverbend register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Anchor, Thread, User, VoiceNote, WriteVia } from '@claude-workspaces/core';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import {
  type NoteToKeep,
  type VoiceNoteThreads,
  clipStart,
  keepNotes,
} from '../src/voice-feedback-keep.ts';
import { VoiceFeedbackRelay, type VoiceWs } from '../src/voice-feedback-relay.ts';
import type { TidyComplete } from '../src/voice-feedback-tidy.ts';
import { waitFor } from './wait-for.ts';

const DOC = 'riverbend-mock';
const ALICE: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const BOB: User = { id: 'known-bob', name: 'Bob', kind: 'known', color: '#d72e7d' };
const BUTTON: Anchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Save',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Save' },
};
const clip = (start: string, end: string) =>
  `/workspaces/riverbend/docs/${DOC}/voice-feedback/seg-1.wav#t=${start},${end}`;

/** Threads in memory, recording every write. */
function memoryThreads(): VoiceNoteThreads & {
  threads: Thread[];
  writes: string[];
  via: Array<WriteVia | undefined>;
} {
  const threads: Thread[] = [];
  const writes: string[] = [];
  const via: Array<WriteVia | undefined> = [];
  let n = 0;
  return {
    threads,
    writes,
    via,
    listThreads: () => threads,
    async postComment(_docId, _threadId, author, text, anchor, opts) {
      n++;
      const t = {
        id: `t${n}`,
        status: 'open',
        anchor,
        commentCount: 1,
        lastActivity: n,
        createdBy: author,
        comments: [{ id: `c${n}`, author, text, ts: n, voice: opts.voice }],
      } as Thread;
      threads.push(t);
      writes.push(`create ${t.id}`);
      via.push(opts.via);
      return t;
    },
    editCommentText(_docId, threadId, commentId, text, opts) {
      const c = threads.find((t) => t.id === threadId)?.comments.find((x) => x.id === commentId);
      if (!c) return { ok: false, error: 'not-found' };
      c.text = text;
      c.voice = opts.voice;
      writes.push(`edit ${threadId} by ${opts.actor.id}`);
      return { ok: true };
    },
  };
}

const seed = (
  store: ReturnType<typeof memoryThreads>,
  text: string,
  voice: VoiceNote,
  author = ALICE,
) => store.postComment(DOC, null, author, text, BUTTON, { voice });

describe('keepNotes', () => {
  it('keeps the part of a clip a growing note never changes', () => {
    expect(clipStart(clip('12.4', '31.0'))).toBe(
      `/workspaces/riverbend/docs/${DOC}/voice-feedback/seg-1.wav#t=12.4,`,
    );
  });

  it('writes a note no thread holds, on the page as a whole when nothing says where', async () => {
    const store = memoryThreads();
    const note: NoteToKeep = {
      key: 'v1',
      text: 'The header is tall.',
      target: 3,
      raw: 'the header is tall',
      clip: clip('0.0', '1.2'),
    };
    const kept = await keepNotes(store, {
      docId: DOC,
      author: ALICE,
      via: 'mock-frame',
      notes: [note],
    });
    expect(kept).toEqual({ created: ['v1'], edited: [], unwritten: [] });
    expect(store.threads[0]?.anchor).toEqual({ kind: 'subject' });
    expect(store.threads[0]?.comments[0]).toMatchObject({
      text: 'The header is tall.',
      author: ALICE,
    });
    expect(store.via).toEqual(['mock-frame']);
  });

  it('a new note about an element an earlier note stands on takes that note’s anchor', async () => {
    const store = memoryThreads();
    await seed(store, 'The Save button hides.', {
      clip: clip('0.0', '1.0'),
      raw: 'the save button hides',
    });
    const notes: NoteToKeep[] = [
      {
        key: 'v1',
        text: 'The Save button hides.',
        target: 1,
        raw: 'the save button hides',
        clip: clip('0.0', '1.0'),
        threadId: 't1',
      },
      {
        key: 'v2',
        text: 'It is grey too.',
        target: 1,
        raw: 'it is grey too',
        clip: clip('1.0', '2.0'),
      },
    ];
    const kept = await keepNotes(store, { docId: DOC, author: ALICE, notes });
    expect(kept).toEqual({ created: ['v2'], edited: [], unwritten: [] });
    expect(store.threads[1]?.anchor).toEqual(BUTTON);
  });

  it('grows the thread the page said it posted, and leaves one that already says it alone', async () => {
    const store = memoryThreads();
    await seed(store, 'The Save button hides.', {
      clip: clip('0.0', '1.0'),
      raw: 'the save button hides',
    });
    await seed(store, 'The footer is faint.', { clip: clip('1.0', '2.0'), raw: 'footer is faint' });
    const notes: NoteToKeep[] = [
      {
        key: 'v1',
        text: 'The Save button hides behind the footer.',
        target: 1,
        raw: 'the save button hides behind the footer',
        clip: clip('0.0', '1.8'),
        threadId: 't1',
      },
      {
        key: 'v2',
        text: 'The footer is faint.',
        target: 3,
        raw: 'footer is faint',
        clip: clip('1.0', '2.0'),
        threadId: 't2',
      },
    ];
    const kept = await keepNotes(store, { docId: DOC, author: ALICE, notes });
    expect(kept).toEqual({ created: [], edited: ['v1'], unwritten: [] });
    expect(store.threads[0]?.comments[0]?.text).toBe('The Save button hides behind the footer.');
    expect(store.threads[0]?.comments[0]?.voice?.clip).toBe(clip('0.0', '1.8'));
    expect(store.writes).toEqual(['create t1', 'create t2', 'edit t1 by known-alice']);
  });

  it('finds a note the page posted without saying so by where its clip starts', async () => {
    const store = memoryThreads();
    await seed(store, 'The Save button hides.', {
      clip: clip('4.2', '5.0'),
      raw: 'the save button hides',
    });
    const note: NoteToKeep = {
      key: 'v1',
      text: 'The Save button hides behind the footer.',
      target: 1,
      raw: 'the save button hides behind the footer',
      clip: clip('4.2', '6.1'),
    };
    const kept = await keepNotes(store, { docId: DOC, author: ALICE, notes: [note] });
    expect(kept.edited).toEqual(['v1']);
    expect(store.threads).toHaveLength(1);
  });

  it('a thread id the page reports cannot point the write at somebody else’s comment', async () => {
    const store = memoryThreads();
    await seed(
      store,
      'Harborlight is late.',
      { clip: clip('9.0', '9.9'), raw: 'harborlight is late' },
      BOB,
    );
    const kept = await keepNotes(store, {
      docId: DOC,
      author: ALICE,
      notes: [
        {
          key: 'v1',
          text: 'The header is tall.',
          target: null,
          raw: 'the header is tall',
          clip: clip('0.0', '1.2'),
          threadId: 't1',
        },
      ],
    });
    expect(kept.created).toEqual(['v1']);
    expect(store.threads[0]?.comments[0]?.text).toBe('Harborlight is late.');
  });

  it('a mock’s socket leaves alone a note that was not written from inside the mock', async () => {
    const store = memoryThreads();
    await seed(store, 'The Save button hides.', {
      clip: clip('0.0', '1.0'),
      raw: 'the save button hides',
    });
    const note: NoteToKeep = {
      key: 'v1',
      text: 'Rewritten by the mock.',
      target: null,
      raw: 'the save button hides',
      clip: clip('0.0', '1.4'),
    };
    const kept = await keepNotes(store, {
      docId: DOC,
      author: ALICE,
      via: 'mock-frame',
      notes: [note],
    });
    expect(kept).toEqual({ created: [], edited: [], unwritten: [] });
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0]?.comments[0]?.text).toBe('The Save button hides.');
    // The control: the same note from a socket no mock relayed is written.
    expect((await keepNotes(store, { docId: DOC, author: ALICE, notes: [note] })).edited).toEqual([
      'v1',
    ]);
  });

  it('with nobody named, writes as the author of a note the page posted, and names what it could not write', async () => {
    const store = memoryThreads();
    await seed(
      store,
      'The Save button hides.',
      { clip: clip('0.0', '1.0'), raw: 'the save button hides' },
      BOB,
    );
    const kept = await keepNotes(store, {
      docId: DOC,
      author: null,
      notes: [
        {
          key: 'v1',
          text: 'The Save button hides again.',
          target: 1,
          raw: 'the save button hides again',
          clip: clip('0.0', '1.4'),
          threadId: 't1',
        },
        {
          key: 'v2',
          text: 'The footer is faint.',
          target: 3,
          raw: 'footer is faint',
          clip: clip('1.4', '2.0'),
        },
      ],
    });
    expect(kept.edited).toEqual(['v1']);
    expect(kept.created).toEqual(['v2']);
    expect(store.threads[1]?.comments[0]?.author).toEqual(BOB);

    const empty = memoryThreads();
    const none = await keepNotes(empty, {
      docId: DOC,
      author: null,
      notes: [{ key: 'v1', text: 'Lost?', target: null, raw: 'lost', clip: clip('0.0', '0.5') }],
    });
    expect(none).toEqual({ created: [], edited: [], unwritten: ['v1'] });
    expect(empty.threads).toEqual([]);
  });
});

class FakeWs implements VoiceWs {
  readonly frames: Array<{ type: string; [k: string]: unknown }> = [];
  constructor(readonly data: VoiceWs['data']) {}
  send(payload: string): void {
    this.frames.push(JSON.parse(payload));
  }
  close(): void {}
}

describe('the relay keeps a page’s notes when its socket goes', () => {
  let dataDir: string;
  let relay: VoiceFeedbackRelay;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-keep-'));
  });
  afterEach(async () => {
    await relay?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a topic extended across three pauses stays one comment', async () => {
    const store = memoryThreads();
    const replies = [
      '{"comments":[{"continues":false,"text":"The Save button hides.","element":"e1"}]}',
      '{"comments":[{"continues":true,"text":"The Save button hides behind the footer.","element":"e1"}]}',
      '{"comments":[{"continues":true,"text":"The Save button hides behind the footer on narrow screens.","element":"e1"}]}',
    ];
    const tidy: TidyComplete = async () => ({ text: replies.shift() ?? '{"comments":[]}' });
    relay = new VoiceFeedbackRelay({
      engines: [
        createMockTranscriptionEngine([
          { words: ['the', 'save', 'button', 'hides'] },
          { words: ['behind', 'the', 'footer'] },
          { words: ['on', 'narrow', 'screens'] },
        ]),
      ],
      tidy,
      dataDir,
      pauseMs: 5,
      cadenceMs: 20,
      keep: store,
      keepGraceMs: 0,
    });
    const ws = new FakeWs({ docId: DOC, workspaceId: 'riverbend', author: ALICE });
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        targets: [{ i: 1, tag: 'button', text: 'Save' }],
      }),
    );
    await waitFor(() => ws.frames.find((f) => f.type === 'ready'), { describe: 'ready' });
    const speak = (n: number) => {
      for (let i = 0; i < n; i++) relay.onAudio(ws, new Uint8Array(640));
    };
    const texts = () => ws.frames.filter((f) => f.type === 'comment').map((f) => f.text);
    speak(5);
    await waitFor(() => texts().includes('The Save button hides.'), { describe: 'first pause' });
    speak(4);
    await waitFor(() => texts().includes('The Save button hides behind the footer.'), {
      describe: 'second pause',
    });
    // The third stretch is said, and the page goes before it pauses.
    speak(3);
    relay.onClose(ws);

    await waitFor(() => store.threads[0]?.comments[0]?.text.includes('narrow'), {
      describe: 'the kept note',
    });
    expect(new Set(ws.frames.filter((f) => f.type === 'comment').map((f) => f.key))).toEqual(
      new Set(['v1']),
    );
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0]?.comments[0]?.text).toBe(
      'The Save button hides behind the footer on narrow screens.',
    );
    expect(store.threads[0]?.comments[0]?.voice?.raw).toBe(
      'the save button hides behind the footer on narrow screens',
    );
  });

  it('a Stop leaves the writing to the page', async () => {
    const store = memoryThreads();
    relay = new VoiceFeedbackRelay({
      engines: [createMockTranscriptionEngine([{ words: ['the', 'footer', 'is', 'faint'] }])],
      tidy: null,
      dataDir,
      pauseMs: 5,
      cadenceMs: 20,
      keep: store,
      keepGraceMs: 0,
    });
    const ws = new FakeWs({ docId: DOC, workspaceId: 'riverbend', author: ALICE });
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16_000, targets: [] }));
    await waitFor(() => ws.frames.find((f) => f.type === 'ready'), { describe: 'ready' });
    for (let i = 0; i < 3; i++) relay.onAudio(ws, new Uint8Array(640));
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await waitFor(() => ws.frames.find((f) => f.type === 'stopped'), { describe: 'stopped' });
    // The control: the last words became a note the page is told of…
    const said = ws.frames.filter((f) => f.type === 'comment').map((f) => f.text);
    expect([...new Set(said)]).toEqual(['the footer is']);
    // …and the server wrote nothing of its own.
    relay.onClose(ws);
    await relay.dispose();
    expect(store.writes).toEqual([]);
  });

  it('a socket this server hung up on for an ended grant writes nothing more', async () => {
    const run = async (code: number) => {
      const store = memoryThreads();
      relay = new VoiceFeedbackRelay({
        engines: [createMockTranscriptionEngine([{ words: ['the', 'footer', 'is', 'faint'] }])],
        tidy: null,
        dataDir,
        pauseMs: 5,
        cadenceMs: 20,
        keep: store,
        keepGraceMs: 0,
      });
      const ws = new FakeWs({ docId: DOC, workspaceId: 'riverbend', author: ALICE });
      relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16_000, targets: [] }));
      await waitFor(() => ws.frames.find((f) => f.type === 'ready'), { describe: 'ready' });
      for (let i = 0; i < 3; i++) relay.onAudio(ws, new Uint8Array(640));
      relay.onClose(ws, code);
      await relay.dispose();
      return store.writes;
    };
    // The control: the same words, the page gone, are written…
    expect(await run(1001)).toEqual(['create t1']);
    // …and not once the server revoked the socket.
    expect(await run(1008)).toEqual([]);
  });
});
