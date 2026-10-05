/**
 * The word, link and config checks every reader-written field passes before
 * the inbox stores it. Each refusal is driven with the hostile value it
 * exists for; each pass with the nearest harmless value, so a check that
 * refused everything would fail too.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInboxPoster, loadInboxConfig, parseInboxConfig } from '../src/inbox/config.ts';
import { rebuildLink } from '../src/inbox/links.ts';
import { BODY_MAX, checkLineText, checkSenderLabel, cleanBody } from '../src/inbox/text-checks.ts';

/** Built at runtime so no address sits in the source. */
const AT_DOMAIN = ['bob', 'riverbend.example'].join('@');

const reason = (v: { ok: boolean; reason?: string }) => (v.ok ? 'ok' : v.reason);

describe('checkLineText', () => {
  it('keeps a plain sentence, trimmed and NFC', () => {
    expect(checkLineText('  Wants a yes on the Saltmarsh dates  ', 140)).toEqual({
      ok: true,
      value: 'Wants a yes on the Saltmarsh dates',
    });
    expect(checkLineText('Café at noon', 140)).toEqual({ ok: true, value: 'Café at noon' });
    // A bare @ is a word, not an address.
    expect(reason(checkLineText('Meet @ 3 by the ferry', 140))).toBe('ok');
  });

  it.each([
    ['<img src=x onerror=alert(1)>', 'markup'],
    ['Click `here`', 'backtick'],
    ['See [the doc](x)', 'bracket'],
    ['Open https://riverbend.example/x', 'link'],
    ['Open www.riverbend.example', 'link'],
    ['Write to mailto:x', 'link'],
    [`Write to ${AT_DOMAIN}`, 'address'],
    ['Write to bob @ riverbend.example', 'address'],
    // Fullwidth forms fold onto the ASCII ones under NFKC.
    ['＜script＞', 'markup'],
    ['Ask‮evil', 'control character'],
    ['Line\nbreak', 'control character'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('refuses %j (%s)', (raw, why) => {
    expect(reason(checkLineText(raw, 140))).toBe(why);
  });

  it('counts code points against the cap, and refuses a non-string', () => {
    expect(reason(checkLineText('a'.repeat(140), 140))).toBe('ok');
    expect(reason(checkLineText('a'.repeat(141), 140))).toBe('over 140 characters');
    expect(reason(checkLineText('\u{1F600}'.repeat(140), 140))).toBe('ok');
    expect(reason(checkLineText(42, 140))).toBe('not text');
  });
});

describe('checkSenderLabel', () => {
  it('keeps a name and refuses a number or a sentence posing as one', () => {
    expect(reason(checkSenderLabel('Alice (Riverbend)'))).toBe('ok');
    expect(reason(checkSenderLabel('+1 415 555 0100'))).toBe('phone number');
    expect(reason(checkSenderLabel('Hi. Click this. Now!'))).toBe('sentence');
    expect(reason(checkSenderLabel('a'.repeat(49)))).toBe('over 48 characters');
  });
});

describe('cleanBody', () => {
  it('strips controls but keeps lines and tabs, and caps the length', () => {
    expect(cleanBody('Hi\r\nthere\u0007\t​ok ')).toEqual({ ok: true, value: 'Hi\nthere\tok' });
    const long = cleanBody('x'.repeat(BODY_MAX + 500));
    expect(long.ok && [...long.value].length).toBe(BODY_MAX);
    expect(long.ok && long.value.endsWith('…')).toBe(true);
    expect(reason(cleanBody('\u0000\u0001'))).toBe('empty');
  });
});

const GMAIL = { key: 'email', source: 'gmail' as const, label: '' };
const TEXTS = { key: 'texts', source: 'messages' as const, label: '' };
const SLACK = {
  key: 'harbor',
  source: 'slack' as const,
  label: 'Harbor',
  slackHost: 'harborlight',
};

describe('rebuildLink', () => {
  it('rebuilds each allowed form from its parts', () => {
    expect(rebuildLink('https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', GMAIL)).toEqual({
      ok: true,
      link: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5',
    });
    expect(
      rebuildLink(
        'https://harborlight.slack.com/archives/C0123456789/p1727800000123456?thread_ts=1727800000.123456',
        SLACK,
      ),
    ).toEqual({
      ok: true,
      link: 'https://harborlight.slack.com/archives/C0123456789/p1727800000123456?thread_ts=1727800000.123456',
    });
    expect(rebuildLink('sms:+14155550100', TEXTS)).toEqual({ ok: true, link: 'sms:+14155550100' });
    expect(rebuildLink(null, GMAIL)).toEqual({ ok: true, link: null });
  });

  it.each([
    ['javascript:alert(1)', GMAIL],
    ['https://mail.google.com.riverbend.example/mail/u/0/#inbox/18c2f0a1b2c3d4e5', GMAIL],
    ['https://user@mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', GMAIL],
    ['https://mail.google.com/mail/u/0/?x=1#inbox/18c2f0a1b2c3d4e5', GMAIL],
    ['http://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', GMAIL],
    ['https://riverbend.slack.com/archives/C0123456789/p1727800000123456', SLACK],
    ['https://harborlight.slack.com/archives/C0123456789/p1727800000123456?redir=x', SLACK],
    ['https://harborlight.slack.com/archives/C0123456789/p1727800000123456#x', SLACK],
    ['sms:+1', TEXTS],
    ['sms:+14155550100?body=hi', TEXTS],
    ['tel:+14155550100', TEXTS],
    ['https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5 ', GMAIL],
    ['https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', SLACK],
  ])('refuses %j', (raw, ws) => {
    expect(rebuildLink(raw, ws).ok).toBe(false);
  });

  it('refuses an oversized link before parsing it', () => {
    expect(reason(rebuildLink(`https://mail.google.com/${'a'.repeat(400)}`, GMAIL))).toBe(
      'link length',
    );
  });
});

describe('the inbox config', () => {
  it('keeps the built-ins, adds a checked Slack workspace, and names the bad entries', () => {
    const { config, problems } = parseInboxConfig({
      readerAgentId: 'agent-reader',
      slack: [
        { workspace: 'harbor', label: 'Harbor', host: 'harborlight' },
        { workspace: 'email', label: 'Clash', host: 'x' },
        { workspace: 'bad', label: '<b>', host: 'x' },
        { workspace: 'evil', label: 'Evil', host: 'evil.example/x' },
      ],
    });
    expect(config.readerAgentId).toBe('agent-reader');
    expect([...config.workspaces.keys()]).toEqual(['email', 'texts', 'harbor']);
    expect(config.workspaces.get('email')?.source).toBe('gmail');
    expect(problems).toHaveLength(3);
  });

  it('lists posters beside the reader, leaving out bad ids and repeats', () => {
    const { config, problems } = parseInboxConfig({
      readerAgentId: 'agent-reader',
      posterAgentIds: ['agent-saltmarsh', 'a b', 'agent-reader', 'agent-saltmarsh', 7],
    });
    expect(config.posterAgentIds).toEqual(['agent-saltmarsh']);
    expect(problems).toEqual(['posterAgentIds[1] is not an id', 'posterAgentIds[4] is not an id']);
    expect(isInboxPoster(config, 'agent-reader')).toBe(true);
    expect(isInboxPoster(config, 'agent-saltmarsh')).toBe(true);
    expect(isInboxPoster(config, 'agent-riverbend')).toBe(false);
    const old = parseInboxConfig({ readerAgentId: 'agent-reader' });
    expect(old.config.posterAgentIds).toEqual([]);
    expect(old.problems).toEqual([]);
    expect(parseInboxConfig({ posterAgentIds: 'agent-saltmarsh' }).problems).toEqual([
      'posterAgentIds is not a list',
    ]);
  });

  it('allows nobody to post when the file is missing, malformed or names a bad id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-config-'));
    try {
      const lines: string[] = [];
      expect(loadInboxConfig(dir, (l) => lines.push(l)).readerAgentId).toBeNull();
      mkdirSync(join(dir, 'inbox'));
      writeFileSync(join(dir, 'inbox', 'config.json'), '{not json');
      expect(loadInboxConfig(dir, (l) => lines.push(l)).readerAgentId).toBeNull();
      writeFileSync(join(dir, 'inbox', 'config.json'), JSON.stringify({ readerAgentId: 'a b' }));
      expect(loadInboxConfig(dir, (l) => lines.push(l)).readerAgentId).toBeNull();
      expect(lines).toHaveLength(2);
      expect(statSync(join(dir, 'inbox')).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
