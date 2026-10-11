/**
 * A chart's Edit button sits in the title's row, inside the block, and never
 * over the chart.
 *
 * WHY THIS RUNS A REAL BROWSER. The question is where two rectangles land,
 * and happy-dom has no layout (`css-harness.ts` says so). The blocks are
 * built by the real editor in happy-dom, then their markup is laid out by
 * Chrome under the app's own stylesheets and measured there.
 *
 * THE CASE CARRIES ITS OWN CONTROL. After measuring, the probe takes the
 * row's reservation off one title and measures again: the button then sits
 * over the chart, which keeps the assertions from being about nothing.
 *
 * Fixtures are fictional: Riverbend and Harborlight are place names.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { afterAll, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';
import { createEditor } from '../src/editor.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();
const APP = join(import.meta.dirname, '..');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and never
// asserted on. Every expectation below is a measured rectangle.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

const DATA = `data={[
    { x: 1, y: 120 },
    { x: 2, y: 135 },
    { x: 3, y: 128 },
    { x: 4, y: 150 },
  ]}`;

const POST = `<Chart
  title="Riverbend and Harborlight ferry riders by month, both crossings, weekdays and weekends"
  ${DATA}
/>

<Chart
  title="Riverbend riders"
  ${DATA}
/>

<Chart
  ${DATA}
/>
`;

/** The three blocks as the editor builds them: a long title, a block open
 *  for editing, a chart with no title. */
function editorMarkup(): string {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(POST, { mdx: true }));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  try {
    document.querySelectorAll<HTMLElement>('.mdx-block .mdx-edit')[1]?.click();
    return parent.outerHTML;
  } finally {
    handle.destroy();
    parent.remove();
  }
}

const PROBE = `(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const reading = (block) => {
    const title = block.querySelector('.mdx-title');
    const cs = getComputedStyle(block);
    return {
      label: block.querySelector('.mdx-edit').textContent,
      button: box(block.querySelector('.mdx-edit')),
      block: box(block),
      border: parseFloat(cs.borderRightWidth),
      chart: box(block.querySelector('svg.mdx-chart')),
      title: title ? box(title) : null,
    };
  };
  const blocks = [...document.querySelectorAll('.mdx-block.has-chart')];
  const out = { width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
  out.blocks = blocks.map(reading);
  // THE CONTROL: the title's row without the room this change reserves.
  const head = blocks[1].querySelector('.mdx-head');
  head.style.minHeight = '0';
  head.style.paddingRight = '0';
  out.control = reading(blocks[1]);
  return JSON.stringify(out);
})()`;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
interface Reading {
  label: string;
  button: Box;
  block: Box;
  border: number;
  chart: Box;
  title: Box | null;
}
interface Measured {
  width: number;
  scrollWidth: number;
  blocks: Reading[];
  control: Reading;
}

/** A launch plus a load is 4-6s on this machine; vitest's default is 5s. */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mdx-edit-'));
  dirs.push(dir);
  const html = join(dir, 'doc.html');
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${read('src/styles.css')}</style>
<style>${read('src/doc.css')}</style>
<style>${read('src/tokens.css')}</style>
<style>html,body{margin:0} main{max-width:820px;margin:0 auto;padding:0 12px}</style>
</head><body><main>${editorMarkup()}</main></body></html>`,
  );
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `mdxedit${process.pid}${owned.length}`;
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

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe.skipIf(CHROME === null)("a chart's Edit button", () => {
  for (const [preset, width] of [
    ['ipad', 1180],
    ['phone', 430],
  ] as const) {
    it(
      `sits in the title's row, inside the block and clear of the chart, at ${width}`,
      () => {
        const m = measure(preset);
        expect(m.width).toBe(width);
        expect(m.scrollWidth).toBe(width);
        expect(m.blocks.map((b) => b.label)).toEqual(['Edit', 'Done', 'Edit']);
        for (const b of m.blocks) {
          // One size in both states, a thumb's 44px tall.
          expect([b.button.width, b.button.height]).toEqual([64, 44]);
          // Inside the block's border on every side.
          expect(b.button.left).toBeGreaterThanOrEqual(b.block.left + b.border);
          expect(b.button.right).toBeLessThanOrEqual(b.block.right - b.border);
          expect(b.button.top).toBeGreaterThanOrEqual(b.block.top + b.border);
          // Above the chart, so no point or label is drawn under it.
          expect(overlaps(b.button, b.chart)).toBe(false);
          expect(b.button.bottom).toBeLessThanOrEqual(b.chart.top);
          // The title wraps short of it.
          if (b.title) expect(b.title.right).toBeLessThanOrEqual(b.button.left);
        }
        // The long title had to wrap to stay clear.
        const [long, short] = m.blocks;
        expect(long?.title?.height ?? 0).toBeGreaterThan((short?.title?.height ?? 0) * 1.5);

        // THE CONTROL: without the row's room the button covers the chart.
        expect(overlaps(m.control.button, m.control.chart)).toBe(true);
      },
      BROWSER_CASE_MS,
    );
  }
});
