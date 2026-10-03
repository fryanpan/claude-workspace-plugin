/**
 * A review item on an app page, opened from Home: the row's link lands on the
 * page its thread is pinned to, with the item open. `home-app-link-driver.ts`
 * does it in headless Chromium against a real board and the real board
 * client; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { HomeAppLinkRun } from './home-app-link-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'home-app-link-driver.ts');
/** One launch, two bundle builds, four page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let run: HomeAppLinkRun | null = null;
const result = (): HomeAppLinkRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a Home link to a review item on an app page', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as HomeAppLinkRun;
  }, SUITE_MS);

  it('lands on the page the thread is on, with the thread', () => {
    const { landed, threadId } = result();
    expect(landed).toMatch(new RegExp(`/apps/[^/]+/transportation/bike/\\?thread=${threadId}$`));
  });

  it('shows that page in the frame, and opens the item there at both widths', () => {
    const { key, opened } = result();
    expect(key).toMatch(/\/transportation\/bike\/\?cw-frame=1$/);
    expect(opened).toHaveLength(2);
    for (const text of opened) expect(text).toContain('Are the protected lanes right?');
  });
});
