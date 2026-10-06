/**
 * The speech engine's session goes away mid-meeting, and the doc is let go.
 *
 * A phone recording in the background sends no audio, Soniox times the session
 * out and closes it, and the page's socket stays open with nobody on it. The
 * relay used to forward the engine's error and keep the meeting, so every
 * Record press after that was refused as `already_recording` until the dead
 * socket timed out minutes later. Now a session the engine closed on its own
 * ends the meeting, the page is told in the frames the strip already renders,
 * and the next press starts.
 *
 * The engine is a fake whose close the test fires by hand. Nothing sleeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore, listMeetings } from '../src/meetings.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

type Sent = Record<string, unknown>;

/** An engine that keeps every session's callbacks, so the test can kill one. */
function droppingEngine(): { engine: TranscriptionEngine; sessions: TranscriptionOpenOpts[] } {
  const sessions: TranscriptionOpenOpts[] = [];
  return {
    sessions,
    engine: {
      name: 'scripted',
      open: (opts): Promise<TranscriptionSession> => {
        sessions.push(opts);
        return Promise.resolve({ send: () => {}, close: () => Promise.resolve() });
      },
    },
  };
}

function socket(relay: MeetingRelay, docId: string): { ws: MeetingClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const ws: MeetingClient = {
    data: { docId },
    send: (payload) => sent.push(JSON.parse(payload) as Sent),
  };
  relay.onOpen(ws);
  return { ws, sent };
}

const startFrame = JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' });

describe('an engine session that closes mid-meeting', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-engine-lost-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ends the meeting, tells the page, and frees the doc for the next press', async () => {
    const store = new MeetingStore(dataDir);
    const { engine, sessions } = droppingEngine();
    const logs: string[] = [];
    const relay = new MeetingRelay({
      store,
      engines: [engine],
      notes: null,
      broadcast: () => {},
      log: (line) => logs.push(line),
    });
    const docId = 'riverbend-standup';

    // Socket A: the phone, live, then backgrounded. It never closes.
    const a = socket(relay, docId);
    relay.onText(a.ws, startFrame);
    const ready = await waitFor(() => a.sent.find((m) => m.type === 'ready'), {
      describe: 'the first meeting to go live',
    });

    // Soniox times the session out: an error, then a close nobody asked for.
    const session = sessions[0];
    session?.onError('soniox: Request timeout');
    session?.onClosed?.();

    // The page is told, in a frame the strip renders as the meeting's end.
    await waitFor(() => a.sent.find((m) => m.type === 'stopped'), {
      describe: 'a stopped frame on the old socket',
    });
    expect(a.sent.some((m) => m.type === 'error')).toBe(true);
    expect(store.active(docId)).toBeUndefined();
    const record = listMeetings(dataDir, docId).find((m) => m.meetingId === ready.meetingId);
    expect(record?.endedAt).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('endedBy=engine-lost'))).toBe(true);

    // Socket B: the next Record press, while socket A is still open.
    const b = socket(relay, docId);
    relay.onText(b.ws, startFrame);
    const next = await waitFor(
      () => b.sent.find((m) => m.type === 'ready' || m.type === 'unavailable'),
      { describe: 'an answer to the second press' },
    );
    expect(next.type).toBe('ready');

    relay.onClose(b.ws, 1000);
    relay.onClose(a.ws, 1006);
    await relay.dispose();
  });

  it('ignores a close that arrives after the meeting already stopped', async () => {
    const store = new MeetingStore(dataDir);
    const { engine, sessions } = droppingEngine();
    const relay = new MeetingRelay({ store, engines: [engine], notes: null, broadcast: () => {} });
    const docId = 'saltmarsh-review';
    const a = socket(relay, docId);
    relay.onText(a.ws, startFrame);
    await waitFor(() => a.sent.find((m) => m.type === 'ready'), { describe: 'meeting one' });
    relay.onText(a.ws, JSON.stringify({ type: 'stop' }));
    await waitFor(() => a.sent.find((m) => m.type === 'stopped'), { describe: 'the stop' });
    // A second meeting on the same socket, then the FIRST session's late close.
    relay.onText(a.ws, startFrame);
    await waitFor(() => a.sent.filter((m) => m.type === 'ready').length === 2, {
      describe: 'meeting two',
    });
    sessions[0]?.onClosed?.();
    await Promise.resolve();
    expect(store.active(docId)).toBeDefined();
    expect(a.sent.filter((m) => m.type === 'stopped').length).toBe(1);
    relay.onClose(a.ws, 1000);
    await relay.dispose();
  });
});
