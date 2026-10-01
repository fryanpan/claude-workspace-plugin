/**
 * The board mic in spoken mode: hold the mic (or Space), ask, and Claude
 * writes a short overview into the panel above the mic and says the first
 * two sentences of it. Speaking while Claude talks stops it.
 *
 * The socket is `WS /workspaces/<ws>/voice/converse` (the server's
 * `spoken-reply/`), opened at the first press and kept. The answer comes from
 * the board mic's own router, so everything the plain mic does — fast paths,
 * hand-off to the lead — happens here too; the setup switch changes only who
 * hears and who speaks.
 *
 * A press becomes one of two kinds of question:
 *  - held (Space always; the mic past `TAP_MS`): the question ends on release.
 *  - tapped (the mic released inside `TAP_MS`): the listener decides where the
 *    question ends. A second tap ends it by hand.
 * The kind is only known at release or at `TAP_MS`, so the frames said before
 * then are held and sent behind the `start` that names it.
 *
 * THE DELAY is measured in `spoken-reply-turn.ts` and sent to the server as
 * `timing`, which logs it per setup (`spoken-reply/timings.ts` names where it
 * is read). Each point's note is shown in step with its point by
 * `spoken-reply-notes.ts`, and its lead rides the same report.
 */
import {
  SPOKEN_SETUPS,
  type SpokenClientMessage,
  type SpokenHeldSetups,
  type SpokenMode,
  type SpokenServerMessage,
  type SpokenSetup,
  type SpokenTimingSummary,
  parseSpokenServerMessage,
  spokenSetupKey,
} from '@claude-workspaces/core/spoken-reply';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';
import {
  type PlaybackContext,
  type SpokenCaptureOpts,
  type SpokenCaptureStart,
  createSpokenPlayer,
  startSpokenCapture,
} from './spoken-reply-audio.ts';
import { wireSpokenHold } from './spoken-reply-hold.ts';
import { createNoteClock } from './spoken-reply-notes.ts';
import { type SpokenPanel, createSpokenPanel } from './spoken-reply-panel.ts';
import { type Turn, newTurn, timingAt } from './spoken-reply-turn.ts';

/** A press released sooner than this is a tap. */
export const TAP_MS = 300;
/** Frames held before the socket or the question's kind is known: 20s. */
const MAX_HELD_FRAMES = 400;
export const SETUP_KEY = 'cw.spoken-reply.setup';

export interface SpokenSocket {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

export interface SpokenReplyOpts {
  document: Document;
  button: HTMLElement;
  /** `ws(s)://host/workspaces/<ws>/voice/converse`. */
  url: string;
  setups: readonly SpokenSetup[];
  /** Pickable, but refused on the page with the server's one line. */
  held?: SpokenHeldSetups;
  timings: SpokenTimingSummary;
  author: { id: string; name: string; kind?: string };
  getContext(): unknown;
  onNavigate(url: string): void;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  /** A context for the microphone, made inside the press. */
  captureContext?: () => AudioContext | undefined;
  playbackContext?: () => PlaybackContext | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

export interface SpokenReply {
  panel: SpokenPanel;
  setup(): SpokenSetup;
  destroy(): void;
}

const OPEN = 1;

function defaultSocket(url: string): SpokenSocket {
  return new WebSocket(url) as unknown as SpokenSocket;
}

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createSpokenReply(opts: SpokenReplyOpts): SpokenReply {
  const doc = opts.document;
  const now = opts.now ?? (() => performance.now());
  const storage = opts.storage === undefined ? readStorage() : opts.storage;
  const heldLine = (s: SpokenSetup): string | undefined => opts.held?.[spokenSetupKey(s)];
  const available = SPOKEN_SETUPS.filter((s) => opts.setups.includes(s) || heldLine(s));
  let summary = opts.timings;

  const stored = Number(
    (() => {
      try {
        return storage?.getItem(SETUP_KEY);
      } catch {
        return null;
      }
    })(),
  );
  let setup: SpokenSetup = available.includes(stored as SpokenSetup)
    ? (stored as SpokenSetup)
    : (available[0] ?? 1);

  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let captureGen = 0;
  let held: Int16Array[] = [];
  let turn: Turn = newTurn();
  let pressing = false;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  const sendRaw = (data: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(data);
    else if (queue.length < MAX_HELD_FRAMES) queue.push(data);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? defaultSocket)(opts.url);
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
      stopCapture();
      player.stop();
      notes.flush();
      const s = panel.state();
      if (s !== 'idle' && s !== 'done' && s !== 'stopped') {
        panel.note('The connection closed. Press the mic to try again.');
        panel.setState('done');
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
    onFirstWord: (at) => recordDelay(at),
    now,
  });

  const panel = createSpokenPanel({
    document: doc,
    anchor: opts.button,
    setups: available,
    held: opts.held ?? {},
    onStop: () => stopSpeaking(),
    onClose: () => closePanel(),
    onPickSetup: (s) => pickSetup(s),
    onChoice: (text) => choose(text),
  });
  panel.setSetup(setup);
  panel.setDelay(null, summary[spokenSetupKey(setup)]);
  const notes = createNoteClock({ player, land: (i, text) => panel.landNote(i, text), now });

  /** The reply is over: every note shown, and the turn's report sent once. */
  function settle(): void {
    notes.flush();
    const t = turn.pending;
    if (!t) return;
    turn.pending = null;
    const noteLeadMs = notes.leads();
    sendMsg(noteLeadMs.length > 0 ? { ...t, noteLeadMs } : t);
  }

  function pickSetup(s: SpokenSetup): void {
    if (!available.includes(s)) return;
    setup = s;
    try {
      storage?.setItem(SETUP_KEY, String(s));
    } catch {}
    panel.setSetup(s);
    panel.setDelay(null, summary[spokenSetupKey(s)]);
    const line = heldLine(s);
    if (line) refuse(line);
  }

  /** One line in an open panel, and nothing sent or spoken. */
  function refuse(line: string): void {
    panel.open();
    panel.clearBody();
    panel.note(line);
    panel.setState('done');
  }

  function stopCapture(): void {
    captureGen++;
    capture?.stop();
    capture = null;
    held = [];
  }

  function clearTap(): void {
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
  }

  function speakingNow(): boolean {
    const s = panel.state();
    return s === 'speaking' || s === 'asking' || player.playing();
  }

  function stopSpeaking(): void {
    player.stop();
    sendMsg({ type: 'stop' });
    settle();
    panel.setState(turn.asking ? 'waiting' : 'stopped');
  }

  function closePanel(): void {
    clearTap();
    pressing = false;
    stopCapture();
    if (speakingNow()) sendMsg({ type: 'stop' });
    player.stop();
    settle();
    panel.close();
    panel.setState('idle');
  }

  /** The question's kind is known: name it, then send what was held. */
  function commit(mode: SpokenMode): void {
    if (turn.mode) return;
    turn.mode = mode;
    sendMsg({
      type: 'start',
      setup,
      mode,
      context: opts.getContext(),
      author: opts.author,
    });
    for (const f of held) sendRaw(f);
    held = [];
  }

  function press(fromSpace: boolean): void {
    if (pressing) return;
    const blocked = heldLine(setup) ?? insecureOriginMessage(defaultOriginFacts());
    if (blocked) return void refuse(blocked);
    // A second tap on a tapped question that is still listening ends it by hand.
    if (panel.state() === 'listening' && turn.mode === 'tap') {
      finishByHand();
      return;
    }
    pressing = true;
    player.wake();
    ensureSocket();
    const interrupting = speakingNow();
    const answering = interrupting ? turn.asking : panel.state() === 'waiting';
    if (interrupting) {
      player.stop();
      sendMsg({ type: 'stop' });
    }
    settle();
    panel.open();
    if (!interrupting && !answering) panel.clearBody();
    if (interrupting) panel.note('Stopped when you started talking.');
    panel.setYou('…');
    panel.setState('listening');
    stopCapture();
    turn = newTurn();
    const gen = captureGen;
    const Ctor = audioCtor();
    const ctx = opts.captureContext ? opts.captureContext() : Ctor ? new Ctor() : undefined;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm, speech) => {
        if (gen !== captureGen) return;
        if (speech) turn.lastVoiceAt = now();
        if (turn.mode) sendRaw(pcm);
        else if (held.length < MAX_HELD_FRAMES) held.push(pcm);
      },
    }).then((r) => {
      if (gen !== captureGen) {
        if (r.ok) r.capture.stop();
        return;
      }
      if (!r.ok) {
        panel.note(r.message);
        panel.setState('done');
        pressing = false;
        clearTap();
        return;
      }
      capture = r.capture;
    });
    if (fromSpace) commit('hold');
    else {
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (pressing) commit('hold');
      }, TAP_MS);
    }
  }

  function release(): void {
    if (!pressing) return;
    pressing = false;
    if (panel.state() !== 'listening') return;
    if (!turn.mode) {
      clearTap();
      commit('tap');
      return;
    }
    if (turn.mode === 'hold') {
      turn.releasedAt = now();
      stopCapture();
      sendMsg({ type: 'end' });
      panel.setState('sending');
    }
  }

  function finishByHand(): void {
    turn.releasedAt = now();
    stopCapture();
    sendMsg({ type: 'end' });
    panel.setState('sending');
  }

  function choose(text: string): void {
    ensureSocket();
    player.wake();
    player.stop();
    settle();
    stopCapture();
    turn = newTurn(true);
    panel.setYou(text);
    panel.clearBody();
    panel.setState('sending');
    sendMsg({ type: 'say', text });
  }

  function recordDelay(at: number): void {
    const t = timingAt(turn, at);
    if (!t) return;
    turn.timed = true;
    turn.pending = t;
    panel.setDelay(t.delayMs, summary[spokenSetupKey(setup)]);
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
      case 'ready':
        summary = m.timings;
        return;
      case 'heard':
        if (panel.state() === 'listening' || panel.state() === 'sending') panel.setYou(m.text);
        return;
      case 'turn-end':
        turn.turnEndAt = now();
        pressing = false;
        clearTap();
        stopCapture();
        panel.setYou(m.text || '…');
        panel.setState('sending');
        return;
      case 'reply':
        turn.replyAt = now();
        turn.asking = m.asking;
        notes.reset();
        panel.reply({
          spoken: m.spoken,
          detail: m.detail,
          ...(m.choices ? { choices: m.choices } : {}),
          ...(m.points ? { points: m.points } : {}),
        });
        if (!m.spoken) {
          panel.note('Didn’t catch anything.');
          panel.setState('done');
        } else if (panel.state() !== 'speaking' && panel.state() !== 'asking') {
          panel.setState('writing');
        }
        if (m.navigate) opts.onNavigate(m.navigate);
        return;
      case 'note':
        notes.note(m.point, m.text);
        return;
      case 'audio-start':
        player.begin(m.sampleRate);
        panel.setState(turn.asking ? 'asking' : 'speaking');
        return;
      case 'audio-end':
        player.finish(() => {
          settle();
          const s = panel.state();
          if (s === 'speaking') panel.setState('done');
          else if (s === 'asking') panel.setState('waiting');
        });
        return;
      case 'timings':
        summary = m.summary;
        panel.setDelay(undefined, summary[spokenSetupKey(setup)]);
        return;
      case 'error':
        settle();
        stopCapture();
        pressing = false;
        clearTap();
        panel.note(m.message);
        panel.setState('done');
        return;
    }
  }

  const input = wireSpokenHold({
    document: doc,
    button: opts.button,
    onPress: press,
    onRelease: release,
    onEscape: () => {
      if (!panel.isOpen()) return false;
      closePanel();
      return true;
    },
  });

  return {
    panel,
    setup: () => setup,
    destroy() {
      closePanel();
      input.destroy();
      const ws = socket;
      socket = null;
      ws?.close();
      panel.destroy();
    },
  };
}
