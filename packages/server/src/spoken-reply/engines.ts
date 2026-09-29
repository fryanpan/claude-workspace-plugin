/**
 * The real engines behind the spoken reply, built from whichever keys this
 * machine holds. Called by `server-deps.ts` only — the seam rule every billed
 * engine here follows — so a server a test spins up builds none.
 *
 *  - setup 1 needs the Soniox key, which both listens and speaks;
 *  - setup 2 needs the Soniox key, the ElevenLabs secret card, AND
 *    `CW_ELEVENLABS_TRAINING_OFF=1` — see `ELEVENLABS_TRAINING_OFF_VAR`;
 *  - setup 3 needs the Gemini secret card.
 *
 * A missing key drops its setup from the switch; the log line says which,
 * never what the key is.
 */
import { type KeychainRunner, readKeychainPassword } from '../share/keychain.ts';
import { resolveSonioxKey } from '../transcribe-soniox.ts';
import type { TranscriptionEngine } from '../transcribe.ts';
import { createGeminiLive } from './gemini-live.ts';
import {
  ELEVENLABS_ENV_VAR,
  ELEVENLABS_SECRET,
  GEMINI_ENV_VAR,
  GEMINI_SECRET,
  readCardSecret,
} from './keys.ts';
import { type SpokenEngines, availableSetups } from './session.ts';
import { createElevenLabsVoice, createSonioxVoice } from './tts.ts';

/**
 * Whether ElevenLabs may be sent real board text. Every request already
 * carries `enable_logging=false`, but whether that stops training on this
 * account is Bryan's to confirm, so setup 2 stays off until the server is
 * launched with this set to `1`. Off by default: unset, or any other value.
 */
export const ELEVENLABS_TRAINING_OFF_VAR = 'CW_ELEVENLABS_TRAINING_OFF';

export function elevenLabsTrainingOff(env: Record<string, string | undefined>): boolean {
  return env[ELEVENLABS_TRAINING_OFF_VAR]?.trim() === '1';
}

export interface SpokenKeySources {
  env: Record<string, string | undefined>;
  /** Keychain reads; a test passes one that answers nothing. */
  readSoniox: (service: string) => string | null;
  readCard?: KeychainRunner;
}

export function createSpokenEngines(
  listener: TranscriptionEngine | null,
  log: (line: string) => void = (l) => console.log(l),
  keys: SpokenKeySources = { env: process.env, readSoniox: readKeychainPassword },
): SpokenEngines {
  const { env } = keys;
  const soniox = resolveSonioxKey(undefined, env, keys.readSoniox);
  const eleven = readCardSecret(ELEVENLABS_SECRET, ELEVENLABS_ENV_VAR, env, keys.readCard);
  const gemini = readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, env, keys.readCard);
  const cleared = elevenLabsTrainingOff(env);
  const engines: SpokenEngines = {
    listener,
    voices: {
      1: soniox ? createSonioxVoice({ apiKey: soniox }) : null,
      2: eleven && cleared ? createElevenLabsVoice({ apiKey: eleven }) : null,
    },
    gemini: gemini ? createGeminiLive({ apiKey: gemini }) : null,
  };
  const on = availableSetups(engines);
  log(
    `[spoken-reply] setups available: ${on.length > 0 ? on.join(', ') : 'none'}` +
      (listener ? '' : ' (no Soniox listener)') +
      (eleven ? '' : ' (no ElevenLabs card)') +
      (eleven && !cleared ? ` (setup 2 held until ${ELEVENLABS_TRAINING_OFF_VAR}=1)` : '') +
      (gemini ? '' : ' (no Gemini card)'),
  );
  return engines;
}
