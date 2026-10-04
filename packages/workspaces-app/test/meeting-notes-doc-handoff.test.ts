/**
 * A Record press the server answers with a notes doc.
 *
 * On a doc holding the person's own writing the server opens no meeting: it
 * makes a notes doc and answers `notes_doc`, and the page goes there to
 * record, so the notes land in the editor the person is watching. This file
 * drives the strip's half — it asks to hand off, lets the microphone go when
 * told, and hands the page the address with the mode the press chose — and
 * the address the page goes to.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  notesDocEntry,
  wantsHuddleContinue,
  wantsHuddleStart,
  withoutHuddleStart,
} from '../src/huddle-entry.ts';
import { startMeetingCapture } from '../src/meeting-audio.ts';
import { parseMeetingServerMessage } from '../src/meeting-protocol.ts';
import { type MeetingSocket, mountMeetingStrip } from '../src/meeting-strip.ts';
import type { OriginFacts } from '../src/voice-capture.ts';

const SECURE: OriginFacts = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/workspaces/w-harbor/docs/d-quay',
  search: '',
};

/** The socket the strip opens; it keeps what the strip sends. */
class FakeSocket implements MeetingSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  send(data: unknown): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  startFrame(): Record<string, unknown> | undefined {
    const raw = this.sent.find((s) => s.includes('"start"'));
    return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

type Moved = { docId: string; title: string; url: string; mode: string };

function rig(follow: boolean) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const pumpsStopped: number[] = [];
  const moved: Moved[] = [];
  const strip = mountMeetingStrip({
    docId: 'd-quay',
    root,
    alone: () => true,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: (o) =>
      startMeetingCapture({
        ...o,
        deps: {
          readOrigin: () => SECURE,
          getMedia: () =>
            Promise.resolve({
              getTracks: () => [],
              getAudioTracks: () => [],
              getVideoTracks: () => [],
              removeTrack: () => {},
            } as unknown as MediaStream),
          createPump: () =>
            Promise.resolve({
              sampleRate: 48_000,
              onBlock: null,
              stop: () => pumpsStopped.push(1),
            } as never),
        },
      }),
    ...(follow ? { onNotesDoc: (to: Moved) => moved.push(to) } : {}),
  });
  cleanups.push(() => strip.destroy());
  const record = (): HTMLButtonElement =>
    document.querySelector('.meeting-record') as HTMLButtonElement;
  return { strip, sockets, pumpsStopped, moved, record };
}

describe('a Record press on a page that can follow the notes doc', () => {
  it('asks to hand off, and on notes_doc lets the mic go and hands the page the address', async () => {
    const r = rig(true);
    r.record().click();
    await settle();
    const sock = r.sockets[0];
    sock?.onopen?.();
    expect(sock?.startFrame()?.handoff).toBe(true);

    sock?.serve({
      type: 'notes_doc',
      docId: 'd-quaynote',
      title: 'Quay plan — meeting notes',
      url: '/workspaces/w-harbor/docs/d-quaynote',
    });
    await settle();
    expect(r.moved).toEqual([
      {
        docId: 'd-quaynote',
        title: 'Quay plan — meeting notes',
        url: '/workspaces/w-harbor/docs/d-quaynote',
        // The mode this press asked the server for, carried to the next page.
        mode: sock?.startFrame()?.mode,
      },
    ]);
    // Nothing records here: the microphone and the socket are let go, so the
    // next page can open its own, and no retry opens another socket.
    expect(r.pumpsStopped.length).toBeGreaterThan(0);
    expect(sock?.closed).toBe(true);
    expect(r.strip.state().kind).toBe('idle');
    expect(r.sockets).toHaveLength(1);
  });

  it('does not ask on a page that cannot follow', async () => {
    const r = rig(false);
    r.record().click();
    await settle();
    r.sockets[0]?.onopen?.();
    expect(r.sockets[0]?.startFrame()).toBeDefined();
    expect(r.sockets[0]?.startFrame()?.handoff).toBeUndefined();
  });
});

describe('the notes_doc frame', () => {
  it('is read with a board path, and dropped with any other address', () => {
    const frame = (url: string) =>
      JSON.stringify({ type: 'notes_doc', docId: 'd-quaynote', title: 'Notes', url });
    expect(parseMeetingServerMessage(frame('/workspaces/w-harbor/docs/d-quaynote'))).toEqual({
      type: 'notes_doc',
      docId: 'd-quaynote',
      title: 'Notes',
      url: '/workspaces/w-harbor/docs/d-quaynote',
    });
    expect(parseMeetingServerMessage(frame('//example.test/x'))).toBeNull();
    expect(parseMeetingServerMessage(frame('https://example.test/x'))).toBeNull();
  });
});

describe('the address the page goes to', () => {
  it('starts the chosen mode at once and keeps the room facts', () => {
    const href = notesDocEntry(
      '/workspaces/w-harbor/docs/d-quaynote',
      '?speakers=3&engine=soniox&mic=ec1-ns0-agc0&task=t-1',
      'conversation',
    );
    const search = href.slice(href.indexOf('?'));
    const q = new URLSearchParams(search);
    expect(href.startsWith('/workspaces/w-harbor/docs/d-quaynote?')).toBe(true);
    expect(wantsHuddleStart(search)).toBe(true);
    expect(wantsHuddleContinue(search)).toBe(true);
    expect(q.get('mode')).toBe('conversation');
    expect(q.get('speakers')).toBe('3');
    expect(q.get('engine')).toBe('soniox');
    expect(q.get('mic')).toBe('ec1-ns0-agc0');
    // About the doc it left, not the room.
    expect(q.get('task')).toBeNull();
    // One-shot: a reload of the notes doc does not start another recording.
    const after = withoutHuddleStart(href);
    expect(wantsHuddleStart(after.slice(after.indexOf('?')))).toBe(false);
    expect(after).not.toContain('continue=');
    expect(after).toContain('speakers=3');
  });
});
