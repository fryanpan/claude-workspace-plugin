/**
 * Who may manage voice tokens, judged by the route alone: the owner, from
 * anywhere; a caller proving nobody, only when it did not come through
 * the tunnel.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type VoiceApiRouteRequest, handleVoiceApiRoutes } from '../src/routes/voice-api.ts';
import { VoiceChat } from '../src/voice-api/chat.ts';
import { VoiceApiTokens, voiceApiTokenKey, voiceTokensPath } from '../src/voice-api/tokens.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-voice-routes-'));
  dirs.push(dir);
  return {
    chat: new VoiceChat({ list: () => [], send: () => ({ kind: 'unknown' }) }),
    tokens: new VoiceApiTokens(voiceTokensPath(dir), () => voiceApiTokenKey('c'.repeat(64))),
    speakerName: () => 'Alice',
    mintSubject: () => 'known-alice',
    j: (status: number, body: unknown) => Response.json(body, { status }),
  };
}

function mint(over: Partial<VoiceApiRouteRequest>): VoiceApiRouteRequest {
  return {
    req: new Request('http://h/api/voice/tokens', { method: 'POST', body: '{"label":"Phone"}' }),
    pathname: '/api/voice/tokens',
    visitor: null,
    ownerProven: () => false,
    anyoneProven: () => false,
    mustSignIn: () => false,
    requestOrigin: () => 'http://h',
    viaTunnel: () => false,
    ...over,
  };
}

const status = async (rq: VoiceApiRouteRequest) => (await handleVoiceApiRoutes(ctx(), rq))?.status;

describe('the voice token routes', () => {
  it('mint for the owner from anywhere, and for an unproven caller off the tunnel', async () => {
    expect(
      await status(
        mint({ ownerProven: () => true, anyoneProven: () => true, viaTunnel: () => true }),
      ),
    ).toBe(201);
    expect(await status(mint({}))).toBe(201);
  });

  it('refuse an unproven caller through the tunnel, a non-owner, a visitor, and another origin', async () => {
    expect(await status(mint({ viaTunnel: () => true }))).toBe(403);
    expect(await status(mint({ anyoneProven: () => true }))).toBe(403);
    expect(await status(mint({ visitor: { scope: 'share' } }))).toBe(403);
    const cross = new Request('http://h/api/voice/tokens', {
      method: 'POST',
      headers: { origin: 'https://bob.example' },
      body: '{}',
    });
    expect(await status(mint({ req: cross }))).toBe(403);
  });

  it('claims no other path', async () => {
    expect(await handleVoiceApiRoutes(ctx(), mint({ pathname: '/api/voice/agents' }))).toBeNull();
  });
});
