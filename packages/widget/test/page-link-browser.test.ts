/**
 * An agent's link to its thread on an app page opens that page with the
 * thread open, and the thread pins whichever spelling of the page the agent
 * gave. `page-link-driver.ts` does it in headless Chromium against a real
 * board; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { PageLinkRun } from './page-link-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'page-link-driver.ts');
/** One launch, one bundle build, three page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let run: PageLinkRun | null = null;
const result = (): PageLinkRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)("an agent's link to its thread on an app page", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as PageLinkRun;
  }, SUITE_MS);

  it("stores either spelling of the page as the key a person's thread there gets", () => {
    const { personKey, agentKeys } = result();
    expect(personKey).toMatch(/\/transportation\/bike\/\?cw-frame=1$/);
    expect(agentKeys).toEqual([personKey, personKey]);
  });

  it('links to the page the thread is on, with the thread', () => {
    const { link, ids } = result();
    expect(link).toMatch(new RegExp(`/transportation/bike/\\?thread=${ids.slashless}$`));
  });

  it('opens that thread, and pins both threads, where the link lands', () => {
    const { opened, personKey, ids } = result();
    expect(opened.key).toBe(personKey);
    expect([...opened.pins].sort()).toEqual([ids.slashless, ids.framed].sort());
    expect(opened.popover).toContain('Which lanes are protected?');
  });
});
