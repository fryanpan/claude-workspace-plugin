/**
 * "Claude, …" in a meeting recorded from the page's microphone, through the
 * REAL server: a discussion huddle records on its audio socket, and the
 * page's spoken-reply socket hears it (`ears: 'meeting'`). The owner is the
 * person whose signed session cookie the socket's upgrade carried, never a
 * name: signed in as the owner, the request is answered aloud (and noted
 * only when the answer holds a minute, which a brief does not);
 * signed in as anybody else, the socket is told no and nothing is said.
 *
 * Mock transcription, a voice that records what it was given, the server's
 * own emailed-code sign-in with the code read off its log. Fixture names are
 * the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import type { NotesComposer, TickScheduler } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);
process.env.CW_LOG_LOGIN_CODES = '1';

const OWNER = ['owner', 'harborlight.test'].join('@');
const GUEST = ['guest', 'harborlight.test'].join('@');
const ASK = 'Claude, where are we?';
const script = (text: string): MockScriptTurn => ({ words: text.split(' '), settled: text });
const SCRIPT: readonly MockScriptTurn[] = [script(ASK), script(ASK)];
const framesFor = (text: string) => text.split(' ').length + 1;
const NEVER: TickScheduler = { set: () => 0, clear: () => {} };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('"Claude, …" in a mic meeting', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  const said: string[] = [];
  const codes: string[] = [];
  const realLog = console.log;

  const voice: SpokenVoice = {
    name: 'recorded',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };
  // A topic per pass, so the meeting opens the notes section Claude's line
  // is held for, exactly as a real meeting's first note does.
  const composer: NotesComposer = {
    name: 'one-topic',
    compose: () =>
      Promise.resolve([
        { op: 'insert_at_end', markdown: '## Berth\n\n- the berth opens in spring' },
      ]),
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  async function signIn(email: string): Promise<string> {
    const before = codes.length;
    expect((await post('/api/auth/start', { email })).status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const res = await post('/api/auth/verify', { email, code: codes.at(-1) });
    expect(res.status).toBe(200);
    const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    return pair;
  }

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for \S+: (\d{6})/);
      if (m?.[1]) codes.push(m[1]);
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cw-mic-claude-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      ownerEmail: OWNER,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: { composer, quietMs: 60_000, schedule: NEVER },
      spokenReply: {
        listener: { name: 'unused', open: () => Promise.reject(new Error('not this one')) },
        voices: { 1: voice, 2: null },
        gemini: null,
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    console.log = realLog;
    resetOwnerIdentities();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function socket(url: string, cookie?: string) {
    const ws = new WebSocket(url, (cookie ? { headers: { cookie } } : undefined) as never);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`refused: ${url}`)));
    });
    return { ws, frames };
  }

  async function micMeeting(cookie: string) {
    const r = await post(`/workspaces/${boardId}/huddles`, {});
    const docId = ((await r.json()) as { docId: string }).docId;
    const audio = await socket(`${wsBase}${meetingSocketPath(boardId, docId)}`);
    audio.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
      }),
    );
    await waitFor(() => audio.frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    const page = await socket(`${wsBase}/workspaces/${boardId}/voice/converse`, cookie);
    await waitFor(() => page.frames.some((f) => f.type === 'ready'), { describe: 'voice ready' });
    page.ws.send(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId },
      }),
    );
    const speak = (text: string) => {
      for (let i = 0; i < framesFor(text); i++) audio.ws.send(new Uint8Array(640));
    };
    const stop = async () => {
      audio.ws.send(JSON.stringify({ type: 'stop' }));
      await waitFor(() => audio.frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
      audio.ws.close();
      page.ws.close();
    };
    const markdown = (): string => {
      const doc = handle.docStore.get(docId);
      if (!doc) throw new Error(`no doc ${docId}`);
      return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    };
    return { audio, page, speak, stop, markdown };
  }

  it('answers the signed-in owner aloud in one line, and leaves a brief out of the notes', async () => {
    const m = await micMeeting(await signIn(OWNER));
    m.speak(ASK);
    const replies = () => m.page.frames.filter((f) => f.type === 'reply');
    await waitFor(() => replies().length === 1, { describe: 'the answer' });
    const spoken = String(replies()[0]?.spoken ?? '');
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.split(/\s+/).length).toBeLessThanOrEqual(26);
    expect(said).toEqual([spoken]);
    await waitFor(() => m.page.frames.some((f) => f.type === 'audio-end'), {
      describe: 'the answer said',
    });
    await m.stop();
    await waitFor(() => m.markdown().includes('the berth opens in spring'), {
      describe: 'the notes section',
    });
    expect(m.markdown()).not.toContain('where are we');
    expect(m.markdown()).not.toContain('Claude:');
  });

  it('anybody else signed in on the page is told no, and nothing is said', async () => {
    const before = said.length;
    const m = await micMeeting(await signIn(GUEST));
    await waitFor(() => m.page.frames.some((f) => f.type === 'error'), {
      describe: 'the refusal',
    });
    m.speak(ASK);
    await waitFor(() => m.audio.frames.some((f) => f.type === 'transcript' && f.final === true), {
      describe: 'the meeting heard it',
    });
    await m.stop();
    expect(m.page.frames.filter((f) => f.type === 'reply')).toEqual([]);
    expect(said.length).toBe(before);
    await waitFor(() => m.markdown().includes('the berth opens in spring'), {
      describe: 'the notes section',
    });
    expect(m.markdown()).not.toContain('Claude, asked by');
  });
});
