/**
 * An agent comments on a page by its words, and suggests new ones that the
 * reader takes or leaves in place.
 *
 * `suggest-driver.ts` does it in headless Chromium against a real board: the
 * agent opens threads through the route `create_thread` calls, the driver
 * taps their pins inside a served mock's frame, presses Accept on one
 * suggestion and Reject on another, then opens an attached app's page. These
 * cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { SuggestRun } from './suggest-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'suggest-driver.ts');
/** One launch, one bundle build, five page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let run: SuggestRun | null = null;
const result = (): SuggestRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)("an agent's comments and suggestions on a page", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as SuggestRun;
  }, SUITE_MS);

  it('pins every agent thread to the words it named on the mock', () => {
    const { mockPins, ids } = result();
    expect([...mockPins].sort()).toEqual([ids.comment, ids.suggestion, ids.reject].sort());
  });

  it('shows the old words, the new words, Accept and Reject', () => {
    expect(result().shown).toEqual({
      was: 'Riverbend walk',
      now: 'Riverbend Street walk',
      buttons: ['Accept', 'Reject'],
    });
  });

  it('Accept changes the page, files a page edit and resolves the suggestion', () => {
    expect(result().accepted).toEqual({
      edit: {
        before: 'Join the Riverbend walk on Sunday.',
        after: 'Join the Riverbend Street walk on Sunday.',
      },
      resolved: true,
      page: 'Join the Riverbend Street walk on Sunday.',
    });
  });

  it('Reject resolves the suggestion and files nothing', () => {
    // The one edit on the board is Accept's.
    expect(result().rejected).toEqual({
      resolved: true,
      edits: 1,
      page: 'Saltmarsh ferry leaves at nine.',
    });
  });

  it("pins an app thread on the page its path names, and not another page's", () => {
    const { appPins, ids } = result();
    expect(appPins).toEqual([ids.here]);
  });
});
