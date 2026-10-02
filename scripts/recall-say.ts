#!/usr/bin/env bun
/**
 * Can a Recall bot say something into a call? One command answers it live.
 *
 *   bun run meeting:say <meeting-url> [--voice soniox|say] [--hold <seconds>] [--dry-run]
 *
 * It sends a bot named "Harborlight voice test" into the meeting URL, waits
 * until the bot is in the call, says one fixed sentence through Recall's
 * `output_audio`, holds the bot long enough for it to be heard, then takes
 * it out of the call. The last line it prints is a JSON verdict, and
 * `accepted` is whether Recall took the audio.
 *
 * WHAT IT COSTS AND TOUCHES, so whoever runs it knows:
 *  - one Recall bot for about a minute, against the key this server uses
 *    (`RECALL_REGION` picks the region, as it does for the server);
 *  - one Soniox TTS call for the sentence (`--voice say` uses the Mac's own
 *    `say` and `ffmpeg` instead, and costs nothing);
 *  - nothing else. The bot asks for no transcript, its recording is kept for
 *    one hour, and it leaves the call on every way out, a failure included.
 *
 * A host has to admit the bot, and on Zoom it may ask to record; both show
 * on screen as they would for the meeting assistant. `--dry-run` runs the
 * whole sequence against a stubbed Recall and voice, with no network.
 *
 * Keys come from the server's own resolution and are never printed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RecallBot,
  type RecallClient,
  createRecallClient,
  recallConfigFromEnv,
} from '../packages/server/src/recall.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { createSonioxVoice } from '../packages/server/src/spoken-reply/tts.ts';
import { resolveSonioxKey } from '../packages/server/src/transcribe-soniox.ts';

export const SAY_TEXT =
  'This is a voice test from the Harborlight board. If you can hear this, the meeting assistant can speak.';
export const SAY_BOT_NAME = 'Harborlight voice test';

/** Recall's states for a bot that is in the call and can be heard. */
const IN_CALL = new Set(['in_call_recording', 'in_call_not_recording']);
/** States it never comes back from. */
const OVER = new Set(['call_ended', 'done', 'fatal']);

export interface SayVerdict {
  accepted: boolean;
  botId: string | null;
  /** The last status Recall reported for the bot. */
  state: string | null;
  /** Bytes of MP3 sent, when any were. */
  bytes: number;
  /** Recall's refusal, or why nothing was sent. */
  error?: string;
}

export interface SayDeps {
  client: RecallClient;
  /** The sentence as MP3. */
  speak(text: string): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** How long to wait for the bot to be let in. */
  joinTimeoutMs?: number;
  pollMs?: number;
  /** How long to keep the bot in the call after the audio is sent. */
  holdMs?: number;
}

function lastState(bot: RecallBot): string | null {
  return bot.status_changes?.at(-1)?.code ?? null;
}

/** The whole live test, against whatever client and voice it is handed. */
export async function runRecallSay(meetingUrl: string, d: SayDeps): Promise<SayVerdict> {
  const pollMs = d.pollMs ?? 2_000;
  const joinTimeoutMs = d.joinTimeoutMs ?? 180_000;
  const verdict: SayVerdict = { accepted: false, botId: null, state: null, bytes: 0 };
  // Made first, so a slow voice does not keep a bot waiting in the call.
  let mp3: Uint8Array;
  try {
    mp3 = await d.speak(SAY_TEXT);
  } catch (err) {
    return { ...verdict, error: `voice: ${err instanceof Error ? err.message : 'failed'}` };
  }
  try {
    const bot = await d.client.createBot({ meetingUrl, botName: SAY_BOT_NAME, speaks: true });
    verdict.botId = bot.id;
    d.log(`bot ${bot.id} sent; admit "${SAY_BOT_NAME}" if the meeting asks`);
    for (let waited = 0; ; waited += pollMs) {
      verdict.state = lastState(await d.client.getBot(bot.id));
      if (verdict.state && IN_CALL.has(verdict.state)) break;
      if (verdict.state && OVER.has(verdict.state)) {
        return { ...verdict, error: `the bot never joined (${verdict.state})` };
      }
      if (waited >= joinTimeoutMs) return { ...verdict, error: 'timed out waiting to join' };
      await d.sleep(pollMs);
    }
    d.log(`in the call (${verdict.state}); saying the test sentence`);
    try {
      await d.client.outputAudio(bot.id, mp3);
      verdict.accepted = true;
      verdict.bytes = mp3.length;
    } catch (err) {
      verdict.error = err instanceof Error ? err.message : 'output_audio failed';
    }
    await d.sleep(d.holdMs ?? 10_000);
    return verdict;
  } catch (err) {
    return { ...verdict, error: err instanceof Error ? err.message : 'failed' };
  } finally {
    if (verdict.botId) {
      await d.client.leaveCall(verdict.botId).catch((err: unknown) => {
        d.log(`leave_call failed — remove the bot by hand: ${String(err)}`);
      });
    }
  }
}

/** The Mac's own voice, as MP3: free, and no key. */
function sayWithMac(text: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'recall-say-'));
  const aiff = join(dir, 'line.aiff');
  const mp3 = join(dir, 'line.mp3');
  const said = spawnSync('say', ['-o', aiff, text]);
  if (said.status !== 0) throw new Error('`say` failed');
  const enc = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    aiff,
    '-ac',
    '1',
    '-b:a',
    '64k',
    mp3,
  ]);
  if (enc.status !== 0) throw new Error('`ffmpeg` failed (brew install ffmpeg)');
  return new Uint8Array(readFileSync(mp3));
}

function stubbedClient(log: (l: string) => void): RecallClient {
  let polls = 0;
  return {
    config: recallConfigFromEnv({}),
    createBot: async (args) => {
      log(
        `[dry-run] POST /v1/bot/ speaks=${String(args.speaks)} realtime=${String(args.realtimeUrl)}`,
      );
      return { id: 'bot_dry_run' };
    },
    getBot: async (id) => ({
      id,
      status_changes: [{ code: ++polls < 2 ? 'joining_call' : 'in_call_recording' }],
    }),
    leaveCall: async (id) => log(`[dry-run] POST /v1/bot/${id}/leave_call/`),
    outputAudio: async (id, mp3) =>
      log(`[dry-run] POST /v1/bot/${id}/output_audio/ kind=mp3 bytes=${mp3.length}`),
    requestRecordingPermission: async () => true,
    checkKeyRegion: async () => ({ ok: true, region: 'us-east-1' }),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const meetingUrl = args.find((a) => /^https:\/\//.test(a));
  const voiceName = flag('--voice') ?? 'soniox';
  const holdS = Number(flag('--hold') ?? '10');
  if (!meetingUrl || !['soniox', 'say'].includes(voiceName) || !(holdS >= 0)) {
    console.error(
      'usage: bun run meeting:say <meeting-url> [--voice soniox|say] [--hold <seconds>] [--dry-run]',
    );
    return 64;
  }
  const log = (line: string) => console.error(line);
  const client = dryRun
    ? stubbedClient(log)
    : createRecallClient({
        env: process.env,
        config: { ...recallConfigFromEnv(process.env), retentionHours: 1 },
      });
  if (!client) {
    console.error('No Recall key: set CLAUDE_WORKSPACES_RECALL_API_KEY or add it to the Keychain.');
    return 2;
  }
  const speak = async (text: string): Promise<Uint8Array> => {
    if (dryRun) return new Uint8Array(4096);
    if (voiceName === 'say') return sayWithMac(text);
    const key = resolveSonioxKey(undefined, process.env, readKeychainPassword);
    if (!key) throw new Error('no Soniox key; pass --voice say to use the Mac voice');
    const chunks: Uint8Array[] = [];
    await createSonioxVoice({ apiKey: key, audio: 'mp3' }).speak(
      text,
      (b) => chunks.push(b),
      new AbortController().signal,
    );
    return new Uint8Array(Buffer.concat(chunks));
  };
  const verdict = await runRecallSay(meetingUrl, {
    client,
    speak,
    sleep: (ms) => new Promise((r) => setTimeout(r, dryRun ? 0 : ms)),
    log,
    holdMs: holdS * 1000,
  });
  console.log(JSON.stringify(verdict));
  return verdict.accepted ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
