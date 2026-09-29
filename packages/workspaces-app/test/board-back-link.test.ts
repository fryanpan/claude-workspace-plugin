import { describe, expect, it } from 'vitest';
import { buildShell } from '../src/board/board-shell.ts';

/**
 * The topbar `←` on the BOARD goes to `/`: the owner's all-workspaces page,
 * or a member's own list of the boards shared with them.
 *
 * On a door with no list (a per-share hostname) there is nothing above the
 * board, so the arrow is left out rather than pointed at a refusal.
 *
 * The server is the only side that knows which door served the page, so it
 * stamps `data-visitor="1"` — and `data-visitor-home="1"` with the signed-in
 * address where the door has a list — on `#board-root`, and the shell reads it.
 */
describe('the board’s back arrow', () => {
  const shellFor = (visitor: boolean): HTMLElement => {
    const root = document.createElement('div');
    root.id = 'board-root';
    root.dataset.workspaceId = 'w-abc';
    if (visitor) root.dataset.visitor = '1';
    document.body.append(root);
    buildShell(document, root, 'search-revamp', 'w-abc');
    return root;
  };

  it('is there for the owner, and points at the index', () => {
    // The positive control: without it, "absent for a visitor" would pass on
    // a shell that stopped rendering a topbar at all.
    const link = shellFor(false).querySelector('.back-link');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/');
  });

  it('is left out entirely for a share member', () => {
    const root = shellFor(true);
    expect(root.querySelector('.back-link')).toBeNull();
    // …and the rest of the topbar is untouched, so this removed a link and
    // not the header it lived in.
    expect(root.querySelector('.board-topbar')).not.toBeNull();
    expect(root.querySelector('.board-ws-name-text')?.textContent).toBe('search-revamp');
  });

  it('is back for a member whose door lists their boards, beside who is signed in', () => {
    const root = document.createElement('div');
    root.dataset.visitor = '1';
    root.dataset.visitorHome = '1';
    root.dataset.signedInAs = 'alice@harborlight.example';
    document.body.append(root);
    buildShell(document, root, 'Harborlight research', 'w-abc');
    expect(root.querySelector('.back-link')?.getAttribute('href')).toBe('/');
    const line = root.querySelector('.board-signed-in');
    expect(line?.textContent).toContain('Signed in as alice@harborlight.example');
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('/cdn-cgi/access/logout');
    expect(line?.querySelector('a')?.textContent).toBe('Use a different account');
  });

  it('says nothing about sign-in to the owner, or to a visitor with no list', () => {
    expect(shellFor(false).querySelector('.board-signed-in')).toBeNull();
    expect(shellFor(true).querySelector('.board-signed-in')).toBeNull();
  });

  it('escapes the address it prints', () => {
    const root = document.createElement('div');
    root.dataset.visitor = '1';
    root.dataset.visitorHome = '1';
    root.dataset.signedInAs = '<img src=x>@x.example';
    document.body.append(root);
    buildShell(document, root, 'n', 'w-abc');
    expect(root.querySelector('.board-signed-in img')).toBeNull();
    expect(root.querySelector('.board-signed-in b')?.textContent).toBe('<img src=x>@x.example');
  });

  it('treats any other value as the owner — only the server’s own flag hides it', () => {
    for (const value of ['0', 'true', '']) {
      const root = document.createElement('div');
      root.id = 'board-root';
      root.dataset.visitor = value;
      document.body.append(root);
      buildShell(document, root, 'n', 'w-abc');
      expect(root.querySelector('.back-link'), value).not.toBeNull();
    }
  });
});
