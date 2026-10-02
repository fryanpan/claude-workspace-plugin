/**
 * The two keys a spoken reply needs beyond Soniox's, read where a person
 * saved them: the board's secret card.
 *
 * A secret card stores its value BASE64 under `claude-workspaces-secret.<name>`,
 * account `claude-workspaces` (`core/secret-name.ts`), so a reader has to
 * decode what it finds. Soniox is not read here: its key is the operator's own
 * configuration, stored raw, and `resolveSonioxKey` already reads it the way
 * the meeting engine does.
 *
 * READ ONLY, and read by server code at runtime only. The value is returned to
 * the caller that sends it to its vendor and goes nowhere else: not a log
 * line, not an error, not a frame to the browser. A failure is `null`, which
 * every caller reads as "this setup is not configured".
 */
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';
import { type KeychainRunner, readKeychainAccountPassword } from '../share/keychain.ts';

/** The card names Bryan saved the keys under. */
export const ELEVENLABS_SECRET = 'elevenlabs-api-key';
export const GEMINI_SECRET = 'gemini-api-key';

/**
 * Setup 4's two cards. The agent id names which ElevenLabs agent to talk to;
 * it is not a secret, but it sits beside the key it is useless without. The
 * LLM secret is the value ElevenLabs sends back as `Authorization: Bearer`
 * when it calls `/voice-agent/v1/chat/completions` — the route's only
 * credential, so it is generated on this machine and pasted into ElevenLabs,
 * never the other way round.
 */
export const ELEVENLABS_AGENT_ID_SECRET = 'elevenlabs-agent-id';
export const ELEVENLABS_AGENT_LLM_SECRET = 'elevenlabs-agent-llm-secret';

/** Per-launch overrides, the same role `SONIOX_API_KEY` plays for Soniox. */
export const ELEVENLABS_ENV_VAR = 'ELEVENLABS_API_KEY';
export const GEMINI_ENV_VAR = 'GEMINI_API_KEY';
export const ELEVENLABS_AGENT_ID_ENV_VAR = 'ELEVENLABS_AGENT_ID';
export const ELEVENLABS_AGENT_LLM_ENV_VAR = 'CW_ELEVENLABS_AGENT_LLM_SECRET';

/** The shortest LLM secret accepted: 32 characters, the length of
 *  `openssl rand -hex 16`. A shorter one reads as not configured. */
export const AGENT_LLM_SECRET_MIN_CHARS = 32;

/** An ElevenLabs agent id as their dashboard shows one. Anything else is
 *  not put into a URL. */
export function validAgentId(id: string | null): id is string {
  return id !== null && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

export function validAgentLlmSecret(secret: string | null): secret is string {
  return (
    secret !== null && secret.length >= AGENT_LLM_SECRET_MIN_CHARS && /^[\x21-\x7e]+$/.test(secret)
  );
}

/**
 * A secret card's value, decoded — or null when there is none.
 *
 * The env var wins, as it does for every other key this server reads, so a
 * test or a one-off launch can supply a value without touching the Keychain.
 */
export function readCardSecret(
  name: string,
  envVar: string,
  env: Record<string, string | undefined> = process.env,
  run?: KeychainRunner,
): string | null {
  const fromEnv = env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  let stored: string | null;
  try {
    stored = run
      ? readKeychainAccountPassword(storedSecretService(name), SECRET_ACCOUNT, run)
      : readKeychainAccountPassword(storedSecretService(name), SECRET_ACCOUNT);
  } catch {
    return null;
  }
  if (!stored) return null;
  // Not `atob`: a value with a character outside the base64 alphabet would
  // throw there, and this must answer null rather than raise a message that
  // could quote what it was given.
  const decoded = Buffer.from(stored, 'base64').toString('utf8').trim();
  return decoded || null;
}
