/**
 * An open settings page redraws its members list when access changes
 * elsewhere — another tab, a peer owner, or an agent's tool — on the board's
 * own feed (`members.changed`), without a reload and without wiping a removal
 * the reader is half way through confirming.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEventSource, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';

const RIVERBEND = 'riverbend@example.com';
const SALTMARSH = 'saltmarsh@example.com';

const roster = (members: Array<{ email: string; role: string }>) => ({
  you: { email: null, role: 'owner' },
  members,
});

const boardFeed = () => {
  const feed = [...FakeEventSource.opened]
    .reverse()
    .find((es) => es.url.endsWith(`/workspaces/${WS}/events:stream`));
  if (!feed) throw new Error('the board never opened its feed');
  return feed;
};

/** The listed people, past the owner's own "You" row. */
const emails = () =>
  [...el('board-members-list').querySelectorAll('.board-member-who')]
    .map((n) => n.textContent)
    .filter((t) => t !== 'You');

const memberReads = () => server.calls.filter((c) => c.url.endsWith(`/${WS}/members`)).length;

describe('the members list on an open settings page', () => {
  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/members`, roster([{ email: RIVERBEND, role: 'member' }]));
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('redraws a person given access elsewhere', async () => {
    await bootTestBoard();
    await click(el('board-settings'));
    await settle();
    expect(emails()).toEqual([RIVERBEND]);
    server.on(
      `/workspaces/${WS}/members`,
      roster([
        { email: RIVERBEND, role: 'member' },
        { email: SALTMARSH, role: 'owner' },
      ]),
    );
    boardFeed().dispatchEvent(new Event('members.changed'));
    await settle();
    expect(emails()).toEqual([RIVERBEND, SALTMARSH]);
  });

  it('keeps a removal the reader is confirming, while that person is still listed', async () => {
    await bootTestBoard();
    await click(el('board-settings'));
    await settle();
    await click(el('board-members-list').querySelector('.board-member-remove') as HTMLElement);
    await settle();
    server.on(
      `/workspaces/${WS}/members`,
      roster([
        { email: RIVERBEND, role: 'member' },
        { email: SALTMARSH, role: 'member' },
      ]),
    );
    boardFeed().dispatchEvent(new Event('members.changed'));
    await settle();
    expect(el('board-members-list').querySelector('.board-member--confirm')?.textContent).toContain(
      `Remove ${RIVERBEND}?`,
    );
    expect(emails()).toContain(SALTMARSH);
  });

  it('reads nothing while settings is closed', async () => {
    await bootTestBoard();
    await settle();
    const before = memberReads();
    boardFeed().dispatchEvent(new Event('members.changed'));
    await settle();
    expect(memberReads()).toBe(before);
  });
});
