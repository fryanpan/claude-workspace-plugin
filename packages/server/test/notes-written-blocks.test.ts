/**
 * The record of which blocks a meeting wrote, across every recording leg.
 *
 * It exists because the authorship marks do not last a leg: each one releases
 * them when it starts. So the record has to outlive a leg, a process, and a
 * second meeting on the same doc, and say for the whole doc which blocks are
 * minutes. All ids are synthetic.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotesWrittenBlocks } from '../src/notes-written-blocks.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-written-'));
  dirs.push(dir);
  return dir;
};

const A = { docId: 'd-saltmarsh', meetingId: 'm-1' };
const B = { docId: 'd-saltmarsh', meetingId: 'm-2' };

describe('the written-blocks record', () => {
  it('only grows, leg after leg', () => {
    const written = createNotesWrittenBlocks(fresh());
    written.add(A, ['b1', 'b2']);
    written.add(A, ['b2', 'b3']);
    expect([...written.read(A)].sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('survives a restart when there is a data dir', () => {
    const dir = fresh();
    createNotesWrittenBlocks(dir).add(A, ['b1']);
    expect([...createNotesWrittenBlocks(dir).read(A)]).toEqual(['b1']);
  });

  it('keeps meetings apart, and answers for the whole doc', () => {
    const dir = fresh();
    const written = createNotesWrittenBlocks(dir);
    written.add(A, ['b1']);
    written.add(B, ['b9']);
    expect([...written.read(A)]).toEqual(['b1']);
    expect([...createNotesWrittenBlocks(dir).writtenInDoc('d-saltmarsh')].sort()).toEqual([
      'b1',
      'b9',
    ]);
    expect(written.writtenInDoc('d-other').size).toBe(0);
  });

  it('works in memory with no data dir', () => {
    const written = createNotesWrittenBlocks();
    written.add(A, ['b1']);
    expect([...written.read(A)]).toEqual(['b1']);
    expect([...written.writtenInDoc('d-saltmarsh')]).toEqual(['b1']);
  });
});
