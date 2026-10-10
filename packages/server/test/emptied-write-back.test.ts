/**
 * A doc emptied in the editor still empties its bound file — and the file's
 * old text is kept in `clobber-backups/` first.
 *
 * On 10 Oct a select-all and Delete in the review editor emptied a bound
 * `.mdx`, the write-back carried the empty doc to disk a second later, and the
 * file went to 0 bytes with no copy anywhere but inside the `.ydoc`. The write
 * is not refused, because a person clearing a doc on purpose must be able to;
 * what these pin is that the words are also a file somebody can find.
 *
 * The negative control is an ordinary edit, which keeps no copy: a backup per
 * keystroke would bury the one that matters.
 *
 * The doc, the path and the words are invented.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { DocStore } from '../src/doc-store.ts';
import { writeEmptiesFile } from '../src/file-binding.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor, waitForFile } from './wait-for.ts';

const POST = `# Riverbend school trips

Walking fell every year since 2005, and biking held.

<Callout type="note">
  The Harborlight survey ran at four schools.
</Callout>

The goal line is the district target.
`;

/** See bound-file-drop.test.ts: the polls cost nothing on a quiet machine
 *  and survive a shard that holds several server-starting files. */
const SETTLE_MS = 15_000;

function bind(docId: string): { docStore: DocStore; dataDir: string; path: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-emptied-'));
  const path = join(dataDir, 'trips.mdx');
  writeFileSync(path, POST);
  const docStore = new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
  docStore.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
  expect(docStore.attachFile(docId, path).ok).toBe(true);
  return { docStore, dataDir, path };
}

/** What the browser's select-all and Delete does to the doc. */
function emptyTheDoc(docStore: DocStore, docId: string): void {
  const doc = docStore.get(docId);
  if (!doc) throw new Error(`no live doc ${docId}`);
  const fragment = prose.getProseFragment(doc.ydoc);
  doc.ydoc.transact(() => fragment.delete(0, fragment.length));
}

function backups(dataDir: string): Array<{ name: string; text: string }> {
  const dir = join(dataDir, 'clobber-backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

describe('a write-back that empties a bound file', () => {
  it('still empties the file, and keeps what it held in clobber-backups', async () => {
    const { docStore, dataDir, path } = bind('d-emptied');
    emptyTheDoc(docStore, 'd-emptied');
    await waitForFile(path, (text) => text.trim() === '', { timeout: SETTLE_MS });
    await waitFor(() => backups(dataDir).length > 0, {
      describe: 'the copy of the emptied file',
      timeout: SETTLE_MS,
    });
    const kept = backups(dataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.name).toContain('-emptied-');
    expect(kept[0]?.text).toContain('Walking fell every year since 2005, and biking held.');
    expect(kept[0]?.text).toContain('The Harborlight survey ran at four schools.');
  }, 45_000);

  it('keeps no copy for an ordinary edit', async () => {
    const { docStore, dataDir, path } = bind('d-ordinary');
    const res = docStore.applyBlockEdits(
      'd-ordinary',
      [{ op: 'insert_at_end', markdown: 'Biking may double by 2030.' }],
      { author: 'riverbend-agent', authorName: 'Riverbend agent' },
    );
    expect(res).toMatchObject({ ok: true, applied: 1 });
    await waitForFile(path, (text) => text.includes('Biking may double by 2030.'), {
      timeout: SETTLE_MS,
    });
    expect(backups(dataDir)).toEqual([]);
  }, 45_000);
});

describe('writeEmptiesFile', () => {
  it('counts a write that keeps under a tenth of real content', () => {
    expect(writeEmptiesFile(POST, '')).toBe(true);
    expect(writeEmptiesFile(POST, '\n')).toBe(true);
    expect(writeEmptiesFile(POST, '#\n')).toBe(true);
  });

  it('leaves alone a shortened file, and a file that held almost nothing', () => {
    expect(writeEmptiesFile(POST, POST.slice(0, POST.length / 2))).toBe(false);
    expect(writeEmptiesFile('# Riverbend\n\nA stub.\n', '')).toBe(false);
  });
});
