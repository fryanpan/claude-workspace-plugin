/**
 * The mock render check the building-a-mock skill ships, run as an agent in
 * another repository runs it: `node check-mock-render.mjs --url …`, against a
 * mock served by a real board server through its host page and sandboxed
 * frame. `check-mock-render-driver.ts` sets up the server and prints what the
 * check said about three mocks.
 *
 * audit: no-text — the driver reads a running server and the check's output;
 * nothing here reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { RenderReading } from './check-mock-render-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'check-mock-render-driver.ts');
const CHECK = join(import.meta.dirname, '../skills/building-a-mock/check-mock-render.mjs');
/** A widget build, two servers, and three checks of three sizes each. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

describe('the check refuses to run on bad input, without launching anything', () => {
  it('exits 2 and prints usage when no url is given', () => {
    const r = spawnSync('node', [CHECK], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--url must be an http(s) address');
  });

  it('exits 2 on a malformed size', () => {
    const r = spawnSync('node', [CHECK, '--url', 'http://127.0.0.1:1/', '--sizes', '430'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bad size "430"');
  });
});

let reading: RenderReading;

describe.skipIf(CHROME === null)('the check, against a mock served by a real board', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as RenderReading;
  }, SUITE_MS);

  it('passes a mock that fits a phone and carries the widget, at all three sizes', () => {
    expect(reading.fits.status, reading.fits.stderr).toBe(0);
    expect(reading.fits.verdict?.results.map((r) => [r.size, r.pass])).toEqual([
      ['1900x1200', true],
      ['1180x820', true],
      ['430x932', true],
    ]);
  });

  it('fails a mock that scrolls sideways at 430, and only at 430', () => {
    expect(reading.wide.status).toBe(1);
    const bySize = Object.fromEntries(
      (reading.wide.verdict?.results ?? []).map((r) => [r.size, r.failures]),
    );
    expect(bySize['1180x820']).toEqual([]);
    expect(bySize['430x932']).toEqual(['scrolls sideways: 1000px content in 430px']);
  });

  it('fails when the board served no widget', () => {
    expect(reading.noWidget.status).toBe(1);
    for (const r of reading.noWidget.verdict?.results ?? []) {
      expect(r.failures).toContain('widget missing or hidden');
    }
    expect(reading.noWidget.verdict?.results).toHaveLength(3);
  });
});
