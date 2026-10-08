/**
 * The voice API bearer: minted once, verified only under its own key and
 * format, revoked one at a time, and kept on disk mode 600 without values.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { VoiceApiTokens, voiceApiTokenKey, voiceTokensPath } from '../src/voice-api/tokens.ts';

const COOKIE_KEY = 'a'.repeat(64);
const dirs: string[] = [];

function store(key = voiceApiTokenKey(COOKIE_KEY)) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-voice-tokens-'));
  dirs.push(dir);
  let n = 0;
  const path = voiceTokensPath(dir);
  const make = (k = key) =>
    new VoiceApiTokens(
      path,
      () => k,
      () => 1_000,
      () => `harborlight-token-${++n}`.padEnd(20, 'x'),
    );
  return { path, make };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('VoiceApiTokens', () => {
  it('verifies the token it minted, and names who it speaks for', () => {
    const { make } = store();
    const tokens = make();
    const { record, token } = tokens.mint('  Phone  ', 'known-alice');
    expect(record.label).toBe('Phone');
    expect(tokens.verify(token)?.subject).toBe('known-alice');
    // A second process reading the same file agrees.
    expect(make().verify(token)?.id).toBe(record.id);
  });

  it('keeps no token value on disk, and writes the file mode 600', () => {
    const { path, make } = store();
    const { token } = make().mint('Phone', 'known-alice');
    const mac = token.split('.').at(-1) ?? '?';
    expect(readFileSync(path, 'utf8')).not.toContain(mac);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a token minted under another key or another format', () => {
    const { make } = store();
    const tokens = make();
    const { token } = tokens.mint('Phone', 'known-alice');
    expect(make(voiceApiTokenKey('b'.repeat(64))).verify(token)).toBeNull();
    // An agent token from the same cookie key is not a voice token.
    expect(tokens.verify(mintAgentToken('harborlight-lead', agentTokenKey(COOKIE_KEY)))).toBeNull();
    expect(tokens.verify(`${token}x`)).toBeNull();
    expect(tokens.verify(null)).toBeNull();
  });

  it('revokes one token and keeps its record, marked', () => {
    const { make } = store();
    const tokens = make();
    const a = tokens.mint('Phone', 'known-alice');
    const b = tokens.mint('Tablet', 'known-alice');
    expect(tokens.revoke(a.record.id)).toBe(true);
    expect(tokens.verify(a.token)).toBeNull();
    expect(tokens.verify(b.token)).not.toBeNull();
    expect(
      make()
        .list()
        .find((r) => r.id === a.record.id)?.revokedAt,
    ).toBe(1_000);
    expect(tokens.revoke('no-such-token-at-all')).toBe(false);
  });
});
