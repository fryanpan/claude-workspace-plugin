/**
 * The pure half of a share link's landing: what a landing may say, whether
 * what it names is on the link's board, and the path it redirects to. The
 * route half — minting, redeeming, and the gate the landed page meets — is
 * `share-link-landing.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  type LandingLookups,
  landingOnBoard,
  landingPath,
  parseShareLanding,
} from '../src/share/share-landing.ts';

const BOARD = 'board-one';
const OTHER = 'board-two';

/** Two boards: a doc, a mock, an app and a task on one; a doc on the other. */
const look: LandingLookups = {
  taskBoardOf: (id) => ({ 't-here': BOARD, 't-there': OTHER })[id],
  boardDocIds: (ws) =>
    ws === BOARD ? ['d-plan', 'd-mock', 'd-site'] : ws === OTHER ? ['d-private'] : [],
  resolveDocId: (id) => (id === 'riverbend-plan' ? 'd-plan' : id),
  docTypeOf: (id) =>
    ({ 'd-plan': 'markdown', 'd-mock': 'mockup', 'd-site': 'app', 'd-private': 'markdown' })[id],
};

describe('parseShareLanding', () => {
  it('reads an absent landing as the board', () => {
    expect(parseShareLanding(undefined)).toEqual({ ok: true, landing: undefined });
    expect(parseShareLanding(null)).toEqual({ ok: true, landing: undefined });
  });

  it('needs an id for every kind that names one resource, and none for home or board', () => {
    expect(parseShareLanding({ kind: 'home' })).toEqual({ ok: true, landing: { kind: 'home' } });
    expect(parseShareLanding({ kind: 'board', id: 'ignored' })).toEqual({
      ok: true,
      landing: { kind: 'board' },
    });
    for (const kind of ['task', 'doc', 'mockup', 'app'] as const) {
      expect(parseShareLanding({ kind }).ok).toBe(false);
      expect(parseShareLanding({ kind, id: '' }).ok).toBe(false);
      expect(parseShareLanding({ kind, id: 'x'.repeat(201) }).ok).toBe(false);
      expect(parseShareLanding({ kind, id: 'd-plan' })).toEqual({
        ok: true,
        landing: { kind, id: 'd-plan' },
      });
    }
  });

  it('refuses an unknown kind and anything that is not an object', () => {
    for (const raw of [{ kind: 'settings' }, { kind: 1 }, 'doc', ['doc'], 7]) {
      expect(parseShareLanding(raw).ok).toBe(false);
    }
  });
});

describe('landingOnBoard', () => {
  it('keeps a task, doc, mock or app on the board, with the doc id made canonical', () => {
    expect(landingOnBoard(BOARD, { kind: 'task', id: 't-here' }, look)).toEqual({
      kind: 'task',
      id: 't-here',
    });
    expect(landingOnBoard(BOARD, { kind: 'doc', id: 'riverbend-plan' }, look)).toEqual({
      kind: 'doc',
      id: 'd-plan',
    });
    expect(landingOnBoard(BOARD, { kind: 'mockup', id: 'd-mock' }, look)).not.toBeNull();
    expect(landingOnBoard(BOARD, { kind: 'app', id: 'd-site' }, look)).not.toBeNull();
  });

  it('refuses a resource on another board, and one that does not exist', () => {
    expect(landingOnBoard(BOARD, { kind: 'task', id: 't-there' }, look)).toBeNull();
    expect(landingOnBoard(BOARD, { kind: 'task', id: 't-none' }, look)).toBeNull();
    expect(landingOnBoard(BOARD, { kind: 'doc', id: 'd-private' }, look)).toBeNull();
    expect(landingOnBoard(BOARD, { kind: 'doc', id: 'd-none' }, look)).toBeNull();
  });

  it('refuses a kind that is not what the id is', () => {
    expect(landingOnBoard(BOARD, { kind: 'mockup', id: 'd-plan' }, look)).toBeNull();
    expect(landingOnBoard(BOARD, { kind: 'doc', id: 'd-site' }, look)).toBeNull();
  });
});

describe('landingPath', () => {
  it('opens each kind at its address on the board', () => {
    const b = `/workspaces/${BOARD}`;
    expect(landingPath(BOARD, undefined)).toBe(b);
    expect(landingPath(BOARD, { kind: 'board' })).toBe(b);
    expect(landingPath(BOARD, { kind: 'home' })).toBe(`${b}/home`);
    expect(landingPath(BOARD, { kind: 'task', id: 't-here' })).toBe(`${b}?task=t-here`);
    expect(landingPath(BOARD, { kind: 'doc', id: 'd-plan' })).toBe(`${b}/docs/d-plan`);
    expect(landingPath(BOARD, { kind: 'mockup', id: 'd-mock' })).toBe(`${b}/mockups/d-mock`);
    expect(landingPath(BOARD, { kind: 'app', id: 'd-site' })).toBe(`${b}/apps/d-site/`);
  });

  it('encodes every id, so no id can leave the board path', () => {
    const path = landingPath(BOARD, { kind: 'doc', id: '../../api/deploy' });
    expect(path).toBe(`/workspaces/${BOARD}/docs/..%2F..%2Fapi%2Fdeploy`);
    expect(new URL(path, 'https://share.example.test').pathname.startsWith('/workspaces/')).toBe(
      true,
    );
    expect(landingPath(BOARD, { kind: 'task', id: 'a&thread=x' })).toBe(
      `/workspaces/${BOARD}?task=a%26thread%3Dx`,
    );
  });
});
