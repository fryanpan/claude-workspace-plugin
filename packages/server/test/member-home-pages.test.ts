/**
 * The member's two pages, driven directly: which boards the list keeps and in
 * what order, that a navigation is told apart from an API call, and that the
 * refusal is a function of the email alone.
 *
 * The HTTP behaviour — who reaches these pages at all — is member-home.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
  ACCESS_LOGOUT_PATH,
  memberBoards,
  renderMemberHome,
  renderNotAMember,
  wantsPage,
} from '../src/member-home.ts';
import type { BoardWorkspace } from '../src/tasks.ts';

const ws = (id: string, name: string, extra: Partial<BoardWorkspace> = {}): BoardWorkspace =>
  ({ id, name, goals: [], docIds: [], ...extra }) as BoardWorkspace;

describe('memberBoards', () => {
  const all = [
    ws('w-a', 'Harborlight research', { lastBoardActivityAt: 100 }),
    ws('w-b', 'Riverbend launch', { lastBoardActivityAt: 300 }),
    ws('w-c', 'Saltmarsh site', { lastBoardActivityAt: 500, retiredAt: 1 }),
    ws('w-d', 'Alice notes', { lastBoardActivityAt: 200 }),
  ];

  it('keeps only the boards the predicate admits', () => {
    const rows = memberBoards(
      all,
      (id) => id !== 'w-b',
      () => 'member',
    );
    expect(rows.map((r) => r.id)).not.toContain('w-b');
    expect(rows).toHaveLength(3);
  });

  it('lists live boards first, most recently active first, retired last', () => {
    const rows = memberBoards(
      all,
      () => true,
      () => 'member',
    );
    expect(rows.map((r) => r.id)).toEqual(['w-b', 'w-d', 'w-a', 'w-c']);
    expect(rows.at(-1)?.retired).toBe(true);
  });

  it('asks the role of each board it keeps', () => {
    const rows = memberBoards(
      all,
      (id) => id === 'w-a' || id === 'w-b',
      (id) => (id === 'w-a' ? 'owner' : 'member'),
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.role]))).toEqual({
      'w-a': 'owner',
      'w-b': 'member',
    });
  });
});

describe('wantsPage', () => {
  const r = (method: string, headers: Record<string, string>) =>
    new Request('http://x/', { method, headers });

  it('is a browser navigating', () => {
    expect(wantsPage(r('GET', { 'sec-fetch-mode': 'navigate' }))).toBe(true);
    expect(wantsPage(r('GET', { accept: 'text/html,application/xhtml+xml' }))).toBe(true);
  });

  it('is not a script calling the API, or a write', () => {
    expect(wantsPage(r('GET', { accept: '*/*' }))).toBe(false);
    expect(wantsPage(r('GET', { accept: 'application/json' }))).toBe(false);
    expect(wantsPage(r('POST', { accept: 'text/html', 'sec-fetch-mode': 'navigate' }))).toBe(false);
  });
});

describe('renderMemberHome', () => {
  it('names each board, its link, and what the member may do there', () => {
    const html = renderMemberHome(
      'alice@harborlight.example',
      [
        {
          id: 'w-a',
          name: 'Harborlight research',
          role: 'member',
          lastActivityAt: 0,
          retired: false,
        },
        { id: 'w-b', name: 'Riverbend launch', role: 'owner', lastActivityAt: 0, retired: true },
      ],
      1_000,
    );
    expect(html).toContain('href="/workspaces/w-a/home"');
    expect(html).toContain('Can edit<');
    expect(html).toContain('Can edit and share');
    expect(html).toContain('Retired');
    expect(html).toContain('Signed in as <b>alice@harborlight.example</b>');
    expect(html).toContain(`href="${ACCESS_LOGOUT_PATH}"`);
  });

  it('escapes what it prints', () => {
    const html = renderMemberHome('a<b>@x.example', [
      { id: 'w-"x', name: '<script>', role: 'member', lastActivityAt: 0, retired: false },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('a<b>@');
    expect(html).toContain('href="/workspaces/w-%22x/home"');
  });

  it('says there is nothing yet, and how to sign in as someone else', () => {
    const html = renderMemberHome('bob@riverbend.example', []);
    expect(html).toContain('Nothing is shared with this address yet');
    expect(html).toContain('bob@riverbend.example');
    expect(html).not.toContain('Shared with you');
  });
});

describe('renderNotAMember', () => {
  it('depends on the email and the door, nothing else', () => {
    expect(renderNotAMember('alice@harborlight.example', '/')).toBe(
      renderNotAMember('alice@harborlight.example', '/'),
    );
    const html = renderNotAMember('alice@harborlight.example', '/');
    expect(html).toContain('You don’t have access to this workspace');
    expect(html).toContain('share it with alice@harborlight.example');
    expect(html).toContain('href="/"');
  });

  it('offers no list on a door that has none', () => {
    const html = renderNotAMember('alice@harborlight.example', null);
    expect(html).not.toContain('See your workspaces');
    expect(html).toContain(`href="${ACCESS_LOGOUT_PATH}"`);
  });

  it('names nobody when Access proved no address', () => {
    const html = renderNotAMember(null, null);
    expect(html).not.toContain('Signed in as');
    expect(html).toContain('You don’t have access to this workspace');
  });
});
