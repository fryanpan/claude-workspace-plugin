/**
 * Which setups the engines offer, from the keys a machine holds — and setup 2
 * held back until the server is told ElevenLabs training is off.
 *
 * Keys come from the environment here and the Keychain readers answer
 * nothing, so no real key is read and nothing reaches a vendor: building an
 * engine makes no request.
 */
import { describe, expect, it } from 'bun:test';
import {
  ELEVENLABS_TRAINING_OFF_VAR,
  createSpokenEngines,
  elevenLabsTrainingOff,
} from '../src/spoken-reply/engines.ts';
import { availableSetups } from '../src/spoken-reply/session.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

const LISTENER = {} as TranscriptionEngine;
const NO_KEYCHAIN = {
  readSoniox: () => null,
  readCard: () => ({ status: 44, stdout: '' }),
};

function build(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  const engines = createSpokenEngines(LISTENER, (l) => lines.push(l), { env, ...NO_KEYCHAIN });
  return { setups: availableSetups(engines), line: lines.join('\n') };
}

const KEYS = {
  SONIOX_API_KEY: 'fixture-soniox',
  ELEVENLABS_API_KEY: 'fixture-eleven',
  GEMINI_API_KEY: 'fixture-gemini',
};

describe('createSpokenEngines', () => {
  it('holds setup 2 until training is confirmed off, and says how to release it', () => {
    const held = build(KEYS);
    expect(held.setups).toEqual([1, 3]);
    expect(held.line).toContain(`setup 2 held until ${ELEVENLABS_TRAINING_OFF_VAR}=1`);
    expect(held.line).not.toContain('fixture-');

    const cleared = build({ ...KEYS, [ELEVENLABS_TRAINING_OFF_VAR]: '1' });
    expect(cleared.setups).toEqual([1, 2, 3]);
    expect(cleared.line).not.toContain('held');
  });

  it('drops a setup whose key is missing', () => {
    expect(build({}).setups).toEqual([]);
    expect(build({ SONIOX_API_KEY: 'fixture-soniox' }).setups).toEqual([1]);
  });

  it('reads only the exact value 1 as consent', () => {
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      expect(elevenLabsTrainingOff({ [ELEVENLABS_TRAINING_OFF_VAR]: v })).toBe(false);
    }
    expect(elevenLabsTrainingOff({ [ELEVENLABS_TRAINING_OFF_VAR]: ' 1 ' })).toBe(true);
  });
});
