/**
 * The real engines behind the spoken reply, built from whichever keys this
 * machine holds. Called by `server-deps.ts` only — the seam rule every billed
 * engine here follows — so a server a test spins up builds none.
 *
 *  - setup 1 needs the Soniox key, which both listens and speaks;
 *  - setup 2 needs the Soniox key and the ElevenLabs secret card;
 *  - setup 3 needs the Gemini secret card.
 *
 * A missing key drops its setup from the switch; the log line says which,
 * never what the key is.
 */
import { readKeychainPassword } from '../share/keychain.ts';
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

export function createSpokenEngines(
  listener: TranscriptionEngine | null,
  log: (line: string) => void = (l) => console.log(l),
): SpokenEngines {
  const soniox = resolveSonioxKey(undefined, process.env, readKeychainPassword);
  const eleven = readCardSecret(ELEVENLABS_SECRET, ELEVENLABS_ENV_VAR);
  const gemini = readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR);
  const engines: SpokenEngines = {
    listener,
    voices: {
      1: soniox ? createSonioxVoice({ apiKey: soniox }) : null,
      2: eleven ? createElevenLabsVoice({ apiKey: eleven }) : null,
    },
    gemini: gemini ? createGeminiLive({ apiKey: gemini }) : null,
  };
  const on = availableSetups(engines);
  log(
    `[spoken-reply] setups available: ${on.length > 0 ? on.join(', ') : 'none'}` +
      (listener ? '' : ' (no Soniox listener)') +
      (eleven ? '' : ' (no ElevenLabs card)') +
      (gemini ? '' : ' (no Gemini card)'),
  );
  return engines;
}
