/**
 * The voice rail at the bottom right of a doc (the mic and Talk) never
 * covers the Make Plan and Review row.
 *
 * Measured on staging before this change: at 1180x820, Talk sat inside
 * Review's box (Talk 1076-1168 x 716-748, Review 1009-1139 x 681-798), and at
 * 430 the mic covered Review's right edge. The rail is fixed to the window
 * and the row is placed in the editor pane, so neither knew of the other.
 *
 * WHY THIS RUNS A REAL BROWSER. The question is whether two rectangles
 * overlap, and happy-dom resolves no layout. It also matched
 * `:has(> .plan-float:not([hidden]))` with the float hidden, so a
 * computed-style read there would say the rail rose when it should not.
 *
 * THE CASE CARRIES ITS OWN CONTROL. After measuring, the probe sets the lift
 * to 0 and measures again: the rail is back where it was, over the row.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();
const APP = join(import.meta.dirname, '..');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and never
// asserted on. Every expectation below is a measured rectangle.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/** The row and the rail as staging renders them in a plan meeting. On a wide
 *  layout `new-indicator.ts` seats the row in the margin column and writes
 *  its left and width inline. */
function markup(wide: boolean): string {
  const seat = wide ? ' is-floating" style="left: 879px; width: 260px;' : '';
  return `<div id="editor-pane" style="position:relative;height:100vh">
<div class="doc-floats${seat}"><button type="button" class="plan-float plan-float--make" data-face="make"><span class="plan-float-label">Make Plan</span><span class="plan-float-sub">Ask your agent to create a plan</span></button><button type="button" class="plan-float review-float review-float--ask" data-face="ask"><span class="plan-float-label">Review</span><span class="plan-float-sub">Ask your agent to review the notes</span></button></div>
</div>
<button type="button" class="doc-voice-mic" aria-label="Talk to comment on this doc"></button>
<button type="button" class="doc-interview-btn">Talk</button>`;
}

const PROBE = `(() => {
  const box = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const look = () => ({ plan: box('.plan-float--make'), review: box('.review-float'), mic: box('.doc-voice-mic'), talk: box('.doc-interview-btn') });
  const out = { width: window.innerWidth, now: look() };
  document.body.style.setProperty('--voice-rail-lift', '0px');
  out.unlifted = look();
  document.body.style.removeProperty('--voice-rail-lift');
  for (const f of document.querySelectorAll('.plan-float')) f.hidden = true;
  out.noRow = look();
  return JSON.stringify(out);
})()`;

type Box = [number, number, number, number];
interface Look {
  plan: Box;
  review: Box;
  mic: Box;
  talk: Box;
}
interface Measured {
  width: number;
  now: Look;
  unlifted: Look;
  noRow: Look;
}

const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const railOverRow = (l: Look): boolean =>
  [l.mic, l.talk].some((r) => overlaps(r, l.plan) || overlaps(r, l.review));

/** A launch plus a load is 4-6s on this machine and vitest's default case
 *  budget is 5s, so the default loses to the load rather than to an
 *  assertion. */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-voice-rail-'));
  dirs.push(dir);
  const html = join(dir, 'rail.html');
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${read('src/styles.css')}</style>
<style>${read('src/doc.css')}</style>
<style>${read('src/tokens.css')}</style>
<style>html,body{margin:0}</style>
</head><body>${markup(preset === 'ipad')}</body></html>`,
  );
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `voicerail${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '250', '--eval-file', probe],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as Measured;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
});

describe.skipIf(CHROME === null)('the voice rail and the Make Plan and Review row', () => {
  for (const [preset, width] of [
    ['ipad', 1180],
    ['phone', 430],
  ] as const) {
    it(
      `at ${width}, the mic and Talk clear the row, and sit at their usual place without it`,
      () => {
        const m = measure(preset);
        expect(m.width).toBe(width);
        expect(railOverRow(m.now)).toBe(false);
        // Above the row, not beside it: the rail stays in its column.
        expect(m.now.mic[3]).toBeLessThanOrEqual(Math.min(m.now.plan[1], m.now.review[1]));
        // THE CONTROL: without the lift the rail is over the row again.
        expect(railOverRow(m.unlifted)).toBe(true);
        // With the row hidden the rail drops back to where it always sat.
        expect(m.noRow.mic).toEqual(m.unlifted.mic);
        expect(m.noRow.talk).toEqual(m.unlifted.talk);
      },
      BROWSER_CASE_MS,
    );
  }
});
