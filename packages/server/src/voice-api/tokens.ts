/**
 * The voice conversation API's bearer: `Authorization: Bearer vk1.<id>.<mac>`.
 *
 * Signed through `auth/signed-token.ts` under its own key domain, so no other
 * protocol's value verifies as one and this one verifies as nothing else. It
 * grants `/v1/models` and `/v1/chat/completions` and no other route: no
 * route but those two reads this format.
 *
 * Revocable one at a time. The MAC proves the server minted the id; the
 * record proves it still stands. Each record names the person it speaks for
 * (`subject`), so a turn is attributed to them; today every token is the
 * owner's, because only the owner may mint one (`routes/voice-api.ts`). A
 * per-person allowlist would widen who may mint, and the record already
 * carries who a token is for.
 *
 * The file holds no secret: an id without the key mints nothing. It is still
 * written mode 600, beside the data it governs. A revoked record is kept,
 * marked, rather than deleted.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from '../auth/signed-token.ts';

const VERSION = 'vk1';
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const LAST_USED_SAVE_MS = 60_000;

export const voiceApiToken: TokenFormat<{ id: string }> = {
  keyDomain: 'cw-voice-api-token-v1',
  tags: [VERSION],
  encode: (c) => `${VERSION}.${c.id}`,
  decode(payload) {
    const [version, id, ...rest] = payload.split('.');
    if (version !== VERSION || !id || rest.length > 0 || !ID.test(id)) return null;
    return { id };
  },
  // No time limit: a phone holds it for months. Revocation is the record.
  expiresAt: () => null,
};

export function voiceApiTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, voiceApiToken);
}

export interface VoiceTokenRecord {
  id: string;
  label: string;
  /** The person turns are attributed to. */
  subject: string;
  createdAt: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

export function voiceTokensPath(dataDir: string): string {
  return join(dataDir, 'voice-api-tokens.json');
}

export class VoiceApiTokens {
  private records: VoiceTokenRecord[] | null = null;

  constructor(
    private readonly path: string,
    private readonly key: () => string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomBytes(18).toString('base64url'),
  ) {}

  private load(): VoiceTokenRecord[] {
    if (this.records) return this.records;
    try {
      const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
      const list = Array.isArray(raw?.tokens) ? raw.tokens : [];
      this.records = list.filter(
        (r: unknown): r is VoiceTokenRecord =>
          !!r &&
          typeof (r as VoiceTokenRecord).id === 'string' &&
          ID.test((r as VoiceTokenRecord).id),
      );
    } catch {
      this.records = [];
    }
    return this.records ?? [];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: this.load() }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** A new token. The value is returned once and never stored. */
  mint(label: string, subject: string): { record: VoiceTokenRecord; token: string } {
    const record: VoiceTokenRecord = {
      id: this.newId(),
      label: label.trim().slice(0, 80) || 'Voice app',
      subject,
      createdAt: this.now(),
    };
    this.load().push(record);
    this.save();
    return { record, token: mintToken(voiceApiToken, { id: record.id }, this.key()) };
  }

  list(): VoiceTokenRecord[] {
    return this.load().map((r) => ({ ...r }));
  }

  /** False when no such token. Revoking twice keeps the first time. */
  revoke(id: string): boolean {
    const r = this.load().find((x) => x.id === id);
    if (!r) return false;
    if (r.revokedAt === undefined) {
      r.revokedAt = this.now();
      this.save();
    }
    return true;
  }

  /** The standing record a bearer names, or null. */
  verify(bearer: string | null): VoiceTokenRecord | null {
    const claims = tokenClaims(voiceApiToken, bearer, this.key());
    if (!claims) return null;
    const r = this.load().find((x) => x.id === claims.id);
    if (!r || r.revokedAt !== undefined) return null;
    const now = this.now();
    const stale = r.lastUsedAt === undefined || now - r.lastUsedAt >= LAST_USED_SAVE_MS;
    r.lastUsedAt = now;
    // Written at most once a minute per token, not on every turn.
    if (stale) this.save();
    return { ...r };
  }
}
