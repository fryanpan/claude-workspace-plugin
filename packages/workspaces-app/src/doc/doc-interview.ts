/**
 * Interview mode on the review doc: tap Interview, say "interview me", and
 * Claude asks about the plan's gaps one at a time and writes each answer into
 * its section (the server's `spoken-reply/interview.ts`).
 *
 * It talks over the board mic's spoken-reply socket,
 * `WS /workspaces/<ws>/voice/converse`, with `{ surface: 'doc', docId }` as
 * the context of every turn, and in the setup the board's switch last chose
 * (`SETUP_KEY`), so the three setups are compared here exactly as they are on
 * the board.
 *
 * HANDS FREE. An interview is a run of question and answer, so once Claude
 * has finished saying a question the card listens again by itself, and the
 * listener's own end of speech ends the answer (`tap` mode); Done ends it by
 * hand. The microphone is opened once, inside the tap that opened the card —
 * Safari opens audio only inside a gesture — and frames are sent only while
 * the card is listening, so Claude's own voice is never sent back.
 *
 * SILENCE. When nothing is heard for `SILENCE_MS` after a question, the
 * card ends the turn empty, and the server offers once to skip the question.
 * Only once per question: after the offer it waits for as long as it takes.
 * Setup 3 is left to Gemini's own turn-taking.
 *
 * Mounted only for a writer on a board whose server names a setup.
 */
import {
  SPOKEN_SETUPS,
  type SpokenClientMessage,
  type SpokenHeldSetups,
  type SpokenServerMessage,
  type SpokenSetup,
  parseSpokenServerMessage,
} from '@claude-workspaces/core/spoken-reply';
import {
  type PlaybackContext,
  type SpokenCaptureOpts,
  type SpokenCaptureStart,
  createSpokenPlayer,
  startSpokenCapture,
} from '../board/spoken-reply-audio.ts';
import { SETUP_KEY, type SpokenSocket } from '../board/spoken-reply-client.ts';
import type { MountScope } from '../mount-scope.ts';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';
import { DocInterviewView, type InterviewFrame, START_PROMPT } from './doc-interview-view.ts';

const OPEN = 1;
/** Frames held while the socket connects: 20s of 50ms frames. */
const MAX_QUEUED = 400;
/** How long a question waits in silence before the card says so. */
export const SILENCE_MS = 8000;

export interface DocInterviewOpts {
  docId: string;
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  scope: MountScope;
  /** `GET /workspaces/<ws>/voice/timings`'s answer. */
  setups: readonly SpokenSetup[];
  held?: SpokenHeldSetups;
  url: string;
  document?: Document;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  captureContext?: () => AudioContext | undefined;
  playbackContext?: () => PlaybackContext | null;
  storage?: Pick<Storage, 'getItem'> | null;
  /** The secure-context gate; a test passes one that lets it through. */
  blocked?: () => string | null;
  silenceMs?: number;
}

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** The board's chosen setup when this server runs it, else the first it runs. */
export function interviewSetup(
  setups: readonly SpokenSetup[],
  stored: string | null,
): SpokenSetup | null {
  const want = Number(stored);
  if (setups.includes(want as SpokenSetup)) return want as SpokenSetup;
  return SPOKEN_SETUPS.find((s) => setups.includes(s)) ?? null;
}

export function mountDocInterview(opts: DocInterviewOpts): DocInterviewView {
  const doc = opts.document ?? document;
  const view = new DocInterviewView(doc);
  const storage =
    opts.storage === undefined
      ? (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })()
      : opts.storage;
  const stored = (() => {
    try {
      return storage?.getItem(SETUP_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  const setup = interviewSetup(opts.setups, stored);
  const heldLine = Object.values(opts.held ?? {})[0] ?? 'Spoken replies are not set up here.';

  const frame: InterviewFrame = {
    open: false,
    phase: 'idle',
    question: START_PROMPT,
    heard: '',
    detail: [],
    note: null,
    interviewing: false,
  };
  const draw = (): void => {
    if (!opts.scope.disposed) view.draw(frame);
  };

  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let listening = false;
  let asking = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current question has had its silence turn. */
  let silenced = false;
  const quiet = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };

  const sendRaw = (d: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(d);
    else if (queue.length < MAX_QUEUED) queue.push(d);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? ((u) => new WebSocket(u) as unknown as SpokenSocket))(opts.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const pending = queue;
      queue = [];
      for (const d of pending) ws.send(d);
    };
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      queue = [];
      listening = false;
      player.stop();
      if (frame.open) {
        frame.note = 'The connection closed. Tap Talk to go on.';
        frame.phase = 'done';
        draw();
      }
    };
    socket = ws;
  };

  let playCtx: PlaybackContext | null = null;
  const player = createSpokenPlayer({
    context: () => {
      if (playCtx) return playCtx;
      if (opts.playbackContext) playCtx = opts.playbackContext();
      else {
        const Ctor = audioCtor();
        playCtx = Ctor ? (new Ctor() as unknown as PlaybackContext) : null;
      }
      return playCtx;
    },
    onFirstWord: () => {},
  });

  /** Open the microphone, inside the tap that asked for it. */
  function openCapture(): void {
    if (capture) return;
    const Ctor = audioCtor();
    const ctx = opts.captureContext ? opts.captureContext() : Ctor ? new Ctor() : undefined;
    const holder = { stopped: false };
    capture = { stop: () => void (holder.stopped = true) };
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        if (listening) sendRaw(pcm);
      },
    }).then((r) => {
      if (!r.ok) {
        capture = null;
        listening = false;
        frame.note = r.message;
        frame.phase = 'done';
        draw();
        return;
      }
      if (holder.stopped) r.capture.stop();
      else capture = r.capture;
    });
  }

  function closeCapture(): void {
    listening = false;
    capture?.stop();
    capture = null;
  }

  function listen(): void {
    if (setup === null) return;
    player.stop();
    listening = true;
    frame.phase = 'listening';
    frame.heard = '';
    frame.note = null;
    sendMsg({
      type: 'start',
      setup,
      mode: 'tap',
      context: { surface: 'doc', docId: opts.docId },
      author: opts.author,
    });
    quiet();
    if (frame.interviewing && setup !== 3 && !silenced) {
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (!listening) return;
        silenced = true;
        listening = false;
        sendMsg({ type: 'end' });
        frame.phase = 'thinking';
        draw();
      }, opts.silenceMs ?? SILENCE_MS);
    }
    draw();
  }

  /** A command tapped rather than said: answered as if it had been heard. */
  function say(text: string): void {
    quiet();
    silenced = false;
    listening = false;
    player.stop();
    sendMsg({ type: 'stop' });
    sendMsg({ type: 'say', text });
    frame.heard = text;
    frame.phase = 'thinking';
    draw();
  }

  function afterSpoken(): void {
    if (!frame.open) return;
    if (asking && frame.interviewing) listen();
    else {
      frame.phase = 'done';
      draw();
    }
  }

  function onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      player.push(new Uint8Array(data));
      return;
    }
    if (typeof data !== 'string') return;
    const m = parseSpokenServerMessage(data);
    if (m) onServer(m);
  }

  function onServer(m: SpokenServerMessage): void {
    switch (m.type) {
      case 'heard':
        if (m.text.trim()) quiet();
        if (listening) {
          frame.heard = m.text;
          draw();
        }
        return;
      case 'turn-end':
        quiet();
        if (m.text.trim()) silenced = false;
        listening = false;
        frame.heard = m.text;
        frame.phase = 'thinking';
        draw();
        return;
      case 'reply':
        asking = m.asking;
        frame.interviewing = m.route === 'interview' && m.asking;
        frame.question = m.spoken || frame.question;
        frame.detail = m.detail;
        frame.note = m.spoken ? null : 'Didn’t catch anything. Tap Talk to try again.';
        frame.phase = m.spoken ? 'asking' : 'done';
        draw();
        return;
      case 'audio-start':
        player.begin(m.sampleRate);
        return;
      case 'audio-end':
        player.finish(afterSpoken);
        return;
      case 'error':
        listening = false;
        frame.note = m.message;
        frame.phase = 'done';
        draw();
        return;
      default:
        return;
    }
  }

  function open(): void {
    const blocked =
      setup === null
        ? heldLine
        : (opts.blocked ?? (() => insecureOriginMessage(defaultOriginFacts())))();
    frame.open = true;
    if (blocked) {
      frame.note = blocked;
      frame.phase = 'done';
      draw();
      return;
    }
    player.wake();
    ensureSocket();
    openCapture();
    listen();
  }

  function shut(): void {
    quiet();
    silenced = false;
    if (frame.interviewing) sendMsg({ type: 'say', text: 'that’s enough' });
    else sendMsg({ type: 'stop' });
    closeCapture();
    player.stop();
    Object.assign(frame, {
      open: false,
      phase: 'idle',
      question: START_PROMPT,
      heard: '',
      detail: [],
      note: null,
      interviewing: false,
    } satisfies InterviewFrame);
    draw();
  }

  opts.scope.listen(view.button, 'click', () => {
    if (frame.open) shut();
    else open();
  });
  opts.scope.listen(view.close, 'click', () => shut());
  opts.scope.listen(view.primary, 'click', () => {
    if (frame.phase === 'listening') {
      quiet();
      listening = false;
      sendMsg({ type: 'end' });
      frame.phase = 'thinking';
      draw();
    } else if (frame.phase !== 'thinking') {
      if (!capture) openCapture();
      player.wake();
      ensureSocket();
      if (frame.phase === 'asking') sendMsg({ type: 'stop' });
      listen();
    }
  });
  for (const b of view.commands) {
    opts.scope.listen(b, 'click', () => {
      const text = b.dataset.say;
      if (text) say(text);
    });
  }
  opts.scope.onCleanup(() => {
    quiet();
    closeCapture();
    player.stop();
    const ws = socket;
    socket = null;
    ws?.close();
    view.remove();
  });
  draw();
  return view;
}

/**
 * Ask the server which spoken setups it runs, and mount the Interview button
 * only when it names one (or holds one, so choosing it can say why).
 */
export function wireDocInterview(opts: {
  docId: string;
  workspaceId: string;
  user: { id: string; name: string; kind?: string };
  scope: MountScope;
}): void {
  const base = `/workspaces/${encodeURIComponent(opts.workspaceId)}/voice`;
  void fetch(`${base}/timings`)
    .then((r) =>
      r.ok ? (r.json() as Promise<{ setups?: SpokenSetup[]; held?: SpokenHeldSetups }>) : null,
    )
    .catch(() => null)
    .then((r) => {
      const setups = r?.setups ?? [];
      const held = r?.held ?? {};
      if (opts.scope.disposed || (setups.length === 0 && Object.keys(held).length === 0)) return;
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      mountDocInterview({
        docId: opts.docId,
        workspaceId: opts.workspaceId,
        author: {
          id: opts.user.id,
          name: opts.user.name,
          ...(opts.user.kind ? { kind: opts.user.kind } : {}),
        },
        scope: opts.scope,
        setups,
        held,
        url: `${wsProto}://${location.host}${base}/converse`,
      });
    });
}
