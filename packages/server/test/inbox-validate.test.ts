/**
 * A posted row, field by field: what a hostile reader could put in each one,
 * and that the row is refused (or, for the message text, cleaned) rather than
 * stored. One accepted row first, so a validator that refused everything
 * fails here too.
 */
import { describe, expect, it } from 'bun:test';
import { type ValidateContext, validateRow } from '../src/inbox/validate.ts';
import { CONFIG, NOW, row } from './inbox-fixtures.ts';

const AT_DOMAIN = ['bob', 'riverbend.example'].join('@');
const LIVE = { workspaceId: 'w-harbor', goalId: 'g-1' };

const ctx: ValidateContext = {
  config: CONFIG,
  now: NOW,
  goalIsLive: (ws, g) => ws === LIVE.workspaceId && g === LIVE.goalId,
};

const verdict = (over: Record<string, unknown>) => {
  const v = validateRow(row(over), ctx);
  return v.ok ? 'ok' : v.reason;
};

describe('validateRow accepts a well-formed row', () => {
  it('as given, with the link rebuilt and a live goal kept', () => {
    const v = validateRow(row({ goal: LIVE, stated: '2026-10-03' }), ctx);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.row.goal).toEqual(LIVE);
    expect(v.row.stated).toBe('2026-10-03');
    expect(v.row.link).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/[0-9a-f]{16}$/);
    // The body is returned beside the row, never inside it.
    expect('body' in v.row).toBe(false);
  });

  it('for each source, against its own workspace', () => {
    expect(
      verdict({
        dedupeKey: 'slack:C0123456789-1727800000.123456',
        source: 'slack',
        workspace: 'harbor',
        link: 'https://harborlight.slack.com/archives/C0123456789/p1727800000123456',
      }),
    ).toBe('ok');
    expect(
      verdict({
        dedupeKey: 'messages:chat42',
        source: 'messages',
        workspace: 'texts',
        link: 'imessage:+14155550100',
      }),
    ).toBe('ok');
  });
});

describe('a hostile row is refused or cleaned', () => {
  it.each([
    ['markup in the purpose', { purpose: '<script>fetch("/inbox")</script>' }, 'purpose: markup'],
    ['a link in the purpose', { purpose: 'Pay at https://riverbend.example' }, 'purpose: link'],
    ['an address in the purpose', { purpose: `Reply to ${AT_DOMAIN}` }, 'purpose: address'],
    ['an address as the sender', { senderLabel: AT_DOMAIN }, 'senderLabel: address'],
    ['markup as the sender', { senderLabel: '<b>Bob</b>' }, 'senderLabel: markup'],
    ['an oversized purpose', { purpose: 'a'.repeat(141) }, 'purpose: over 140 characters'],
    ['an oversized sender', { senderLabel: 'B'.repeat(49) }, 'senderLabel: over 48 characters'],
    ['a script link', { link: 'javascript:alert(1)' }, 'link is not an allowed form'],
    [
      'a link off the source host',
      { link: 'https://riverbend.example/x' },
      'link is not an allowed form',
    ],
    ['an unknown field', { html: '<b>x</b>' }, 'unknown field'],
    ['a dedupe key with a slash', { dedupeKey: 'gmail:../../etc' }, 'dedupeKey'],
    [
      'a source that differs from the key',
      { source: 'slack', workspace: 'harbor' },
      'source does not match dedupeKey',
    ],
    ['a workspace not configured', { workspace: 'elsewhere' }, 'workspace'],
    ['a sender key that is not a hash', { senderKey: 'Alice' }, 'senderKey'],
    ['an ask kind not on the list', { askKind: 'urgent!!' }, 'askKind'],
    ['a reply-by not on the list', { replyBy: 'now' }, 'replyBy'],
    ['a message from the far past', { receivedAt: NOW - 15 * 86_400_000 }, 'receivedAt'],
    ['a message from the future', { receivedAt: NOW + 3_600_000 }, 'receivedAt'],
    ['a fractional time', { receivedAt: NOW - 0.5 }, 'receivedAt'],
    ['a huge message count', { messageCount: 10_000 }, 'messageCount'],
    ['a stated date that is not a date', { stated: '2026-02-30' }, 'stated'],
    ['a stated date far ahead', { stated: '2027-06-01' }, 'stated'],
    ['a goal with extra fields', { goal: { ...LIVE, title: '<b>' } }, 'goal'],
    ['a goal that is a string', { goal: 'g-1' }, 'goal'],
  ])('%s', (_name, over, why) => {
    expect(verdict(over)).toBe(why);
  });

  it('an empty body is refused; a body with markup is kept as text, controls stripped, capped', () => {
    expect(verdict({ body: '\u0000' })).toBe('body: empty');
    const v = validateRow(row({ body: '<img src=x onerror=alert(1)>\u0007 '.repeat(400) }), ctx);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // The page draws the body with textContent, so markup is inert; what the
    // store must guarantee is no control characters and a bounded size.
    expect(v.body).not.toContain('\u0007');
    expect([...v.body].length).toBeLessThanOrEqual(4000);
  });

  it('a goal that is not live is dropped, not refused', () => {
    const v = validateRow(row({ goal: { workspaceId: 'w-harbor', goalId: 'g-gone' } }), ctx);
    expect(v.ok && v.row.goal).toBeNull();
  });

  it('a row that is not an object is refused', () => {
    expect(validateRow(null, ctx)).toEqual({ ok: false, reason: 'not an object' });
    expect(validateRow([row()], ctx)).toEqual({ ok: false, reason: 'not an object' });
  });
});
