/**
 * The order the front page shows rows in, and the section it draws: lines
 * per the approved mock, reader-written words escaped, the body absent.
 */
import { describe, expect, it } from 'bun:test';
import { rankRows } from '../src/inbox/rank.ts';
import { INBOX_VISIBLE_LINES, ageText, renderInboxSection } from '../src/inbox/section.ts';
import type { InboxRow } from '../src/inbox/types.ts';
import { CONFIG, NOW } from './inbox-fixtures.ts';

let seq = 0;
function stored(over: Partial<InboxRow> = {}): InboxRow {
  seq += 1;
  return {
    id: `ib-row${String(seq).padStart(8, '0')}`,
    dedupeKey: `gmail:t${seq}`,
    source: 'gmail',
    workspace: 'email',
    senderLabel: 'Alice',
    senderKey: 'a1b2c3d4e5f60718',
    senderKnown: true,
    purpose: `Purpose ${seq}`,
    askKind: 'reply',
    replyBy: 'this-week',
    goal: null,
    link: null,
    receivedAt: NOW - 3_600_000,
    messageCount: 1,
    lastFromOwner: false,
    state: 'open',
    history: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    pass: 'p1',
    ...over,
  };
}

const none = { projectRank: () => undefined, goalIndex: () => undefined };

describe('rankRows', () => {
  it('puts reply-by first, then project rank, goal order, known senders, newest', () => {
    const fyi = stored({ askKind: 'fyi', replyBy: 'today' });
    const today = stored({ replyBy: 'today' });
    const p2 = stored({ goal: { workspaceId: 'w2', goalId: 'g' } });
    const p1g1 = stored({ goal: { workspaceId: 'w1', goalId: 'g1' } });
    const p1g0 = stored({ goal: { workspaceId: 'w1', goalId: 'g0' } });
    const stranger = stored({ senderKnown: false });
    const older = stored({ receivedAt: NOW - 7_200_000 });
    const newer = stored({ receivedAt: NOW - 60_000 });
    const ranked = rankRows([fyi, older, stranger, newer, p2, p1g1, today, p1g0], {
      projectRank: (ws) => ({ w1: 1, w2: 2 })[ws],
      goalIndex: (g) => ({ g0: 0, g1: 1 })[g.goalId],
    });
    expect(ranked.map((r) => r.id)).toEqual(
      [today, p1g0, p1g1, p2, newer, older, stranger, fyi].map((r) => r.id),
    );
  });
});

describe('renderInboxSection', () => {
  const render = (
    rows: InboxRow[],
    extra: Partial<Parameters<typeof renderInboxSection>[0]> = {},
  ) =>
    renderInboxSection({
      rows,
      config: CONFIG,
      goalTitle: () => undefined,
      lastPassAt: NOW,
      now: NOW,
      ...none,
      ...extra,
    });

  it('draws nothing when the inbox was never set up', () => {
    expect(render([], { config: { ...CONFIG, readerAgentId: null }, lastPassAt: undefined })).toBe(
      '',
    );
  });

  it('says so when nothing needs Bryan', () => {
    expect(render([])).toContain('Nothing in your messages needs you right now.');
  });

  it('escapes every reader-written word, and carries no message text', () => {
    const html = render([
      stored({
        purpose: '<b>x</b>',
        senderLabel: '"><img src=x>',
        workspace: 'harbor',
        source: 'slack',
        link: 'https://harborlight.slack.com/archives/C0123456789/p1727800000123456',
      }),
    ]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('data-channel="Slack Harbor"');
    expect(html).not.toContain('inbox-msg');
  });

  it('shows five lines, hides the rest behind "N more", and folds the snoozed', () => {
    const rows = Array.from({ length: INBOX_VISIBLE_LINES + 2 }, () => stored());
    rows.push(stored({ state: 'snoozed', snoozedUntil: NOW + 3_600_000 }));
    const html = render(rows);
    expect(html.match(/class="inbox-row" data-row=/g)).toHaveLength(INBOX_VISIBLE_LINES + 2);
    expect(html.match(/ hidden><div class="inbox-line">/g)).toHaveLength(2);
    expect(html).toContain('>2 more</button>');
    expect(html).toContain('Show 1 snoozed');
    expect(html).toContain('Bring back now');
    expect(html).toContain(`${INBOX_VISIBLE_LINES + 2} open`);
  });

  it('has no buttons on a line but the hover clock, and no reply-by label', () => {
    const html = render([stored({ replyBy: 'today' })]);
    const line = html.slice(
      html.indexOf('<div class="inbox-row"'),
      html.indexOf('</div></div></div>') + 18,
    );
    expect(line.match(/<button/g)).toHaveLength(2); // the line itself and the clock
    expect(line).toContain('data-act="snooze"');
    expect(html.toLowerCase()).not.toContain('reply by');
    expect(html).not.toContain('>today<');
  });
});

describe('ageText', () => {
  it('spells ages as the mock does', () => {
    expect(ageText(NOW - 25 * 60_000, NOW)).toBe('25m');
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(ageText(NOW - 2 * 86_400_000, NOW)).toBe('2d');
    expect(ageText(NOW + 5_000, NOW)).toBe('1m');
  });
});
