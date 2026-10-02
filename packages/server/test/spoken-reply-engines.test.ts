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
  ELEVENLABS_HELD_LINE,
  ELEVENLABS_TRAINING_OFF_VAR,
  agentMissingLine,
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
  return {
    setups: availableSetups(engines),
    held: engines.held,
    agent: engines.agent ?? null,
    line: lines.join('\n'),
  };
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
    expect(held.held?.['2']).toBe(ELEVENLABS_HELD_LINE);

    const cleared = build({ ...KEYS, [ELEVENLABS_TRAINING_OFF_VAR]: '1' });
    expect(cleared.setups).toEqual([1, 2, 3]);
    expect(cleared.line).not.toContain('held');
    expect(cleared.held?.['2']).toBeUndefined();
  });

  const AGENT = {
    ...KEYS,
    [ELEVENLABS_TRAINING_OFF_VAR]: '1',
    ELEVENLABS_AGENT_ID: 'agent_fixture01',
    CW_ELEVENLABS_AGENT_LLM_SECRET: 'f'.repeat(32),
    CW_RECALL_CALLBACK_HOST: 'callback.example.test',
  };

  it('offers setup 4 only with every piece, and names each piece it lacks', () => {
    const all = build(AGENT);
    expect(all.setups).toEqual([1, 2, 3, 4]);
    expect(all.held).toBeUndefined();
    expect(all.agent?.llmSecret).toBe('f'.repeat(32));

    const none = build({ SONIOX_API_KEY: 'fixture-soniox' });
    expect(none.setups).toEqual([1]);
    expect(none.agent).toBeNull();
    expect(none.held?.['4']).toBe(
      'Setup 4 is not set up on this server yet: it needs the elevenlabs-api-key card, ' +
        'the elevenlabs-agent-id card, the elevenlabs-agent-llm-secret card, ' +
        'CW_RECALL_CALLBACK_HOST and CW_ELEVENLABS_TRAINING_OFF=1.',
    );

    const shortSecret = build({ ...AGENT, CW_ELEVENLABS_AGENT_LLM_SECRET: 'short' });
    expect(shortSecret.setups).not.toContain(4);
    expect(shortSecret.held?.['4']).toBe(
      'Setup 4 is not set up on this server yet: it needs the elevenlabs-agent-llm-secret card.',
    );
    expect(shortSecret.line).not.toContain('short');

    const badId = build({ ...AGENT, ELEVENLABS_AGENT_ID: 'agent?x=1' });
    expect(badId.held?.['4']).toContain('the elevenlabs-agent-id card');
    expect(build({ ...AGENT, CW_ELEVENLABS_TRAINING_OFF: '' }).setups).toEqual([1, 3]);
  });

  it('says nothing is missing when nothing is', () => {
    const all = {
      elevenLabsKey: true,
      agentId: true,
      llmSecret: true,
      callbackHost: true,
      trainingOff: true,
    };
    expect(agentMissingLine(all)).toBeNull();
    expect(agentMissingLine({ ...all, callbackHost: false })).toBe(
      'Setup 4 is not set up on this server yet: it needs CW_RECALL_CALLBACK_HOST.',
    );
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
