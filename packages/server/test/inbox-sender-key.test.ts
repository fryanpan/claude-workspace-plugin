/**
 * The sender key the server derives from a row's `senderId`: one key per
 * sender however the id is spelled, a different key per sender, and no key
 * for an id that is not plain text.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { senderKeyFor } from '../src/inbox/sender-key.ts';

const ALICE = ['alice', 'example.com'].join('@');
const BOB = ['bob', 'example.com'].join('@');

describe('senderKeyFor', () => {
  it('is the first 16 hex of SHA-256 over source and normalised id', () => {
    const want = createHash('sha256').update(`gmail:${ALICE}`).digest('hex').slice(0, 16);
    expect(senderKeyFor('gmail', ALICE)).toBe(want);
  });

  it('gives one key for an address however it is cased or padded', () => {
    expect(senderKeyFor('gmail', `  ${ALICE.toUpperCase()} `)).toBe(senderKeyFor('gmail', ALICE));
    expect(senderKeyFor('messages', ` ${ALICE.toUpperCase()}`)).toBe(
      senderKeyFor('messages', ALICE),
    );
  });

  it('gives one key for a Slack id in either case, and a phone number however punctuated', () => {
    expect(senderKeyFor('slack', ' u0123abcd ')).toBe(senderKeyFor('slack', 'U0123ABCD'));
    expect(senderKeyFor('messages', '+1 (415) 555-0100')).toBe(
      senderKeyFor('messages', '+14155550100'),
    );
  });

  it('gives different senders, and one id on two sources, different keys', () => {
    expect(senderKeyFor('gmail', ALICE)).not.toBe(senderKeyFor('gmail', BOB));
    expect(senderKeyFor('gmail', ALICE)).not.toBe(senderKeyFor('messages', ALICE));
  });

  it('gives no key for an empty, oversized, control-bearing or non-string id', () => {
    expect(senderKeyFor('gmail', '')).toBeNull();
    expect(senderKeyFor('gmail', '   ')).toBeNull();
    expect(senderKeyFor('gmail', 'a'.repeat(321))).toBeNull();
    expect(senderKeyFor('gmail', 'a'.repeat(320))).toMatch(/^[0-9a-f]{16}$/);
    expect(senderKeyFor('gmail', `${ALICE}\u0000`)).toBeNull();
    expect(senderKeyFor('slack', 'U01\nU02')).toBeNull();
    expect(senderKeyFor('gmail', 42)).toBeNull();
  });
});
