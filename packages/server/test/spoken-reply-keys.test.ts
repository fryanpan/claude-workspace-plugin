/**
 * The spoken reply reads the ElevenLabs and Gemini keys off the board's
 * secret card: base64, under the card's service name and account. A fake
 * `security` runner stands in for the Keychain; no real key is read.
 */
import { describe, expect, it } from 'bun:test';
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';
import { GEMINI_ENV_VAR, GEMINI_SECRET, readCardSecret } from '../src/spoken-reply/keys.ts';

const PLACEHOLDER = 'not-a-real-key';

function runner(stored: string | null) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return stored === null ? { status: 44, stdout: '' } : { status: 0, stdout: `${stored}\n` };
  };
  return { run, calls };
}

describe('readCardSecret', () => {
  it('decodes what the secret card stored, asking for the card’s service and account', () => {
    const { run, calls } = runner(Buffer.from(PLACEHOLDER).toString('base64'));
    expect(readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, {}, run)).toBe(PLACEHOLDER);
    expect(calls[0]).toEqual([
      'find-generic-password',
      '-a',
      SECRET_ACCOUNT,
      '-s',
      storedSecretService(GEMINI_SECRET),
      '-w',
    ]);
  });

  it('the env var wins and the Keychain is not asked', () => {
    const { run, calls } = runner('ignored');
    expect(
      readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, { [GEMINI_ENV_VAR]: PLACEHOLDER }, run),
    ).toBe(PLACEHOLDER);
    expect(calls).toHaveLength(0);
  });

  it('no card is null', () => {
    expect(readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, {}, runner(null).run)).toBeNull();
  });

  it('a runner that throws is null, not an error', () => {
    const run = () => {
      throw new Error('boom');
    };
    expect(readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, {}, run)).toBeNull();
  });
});
