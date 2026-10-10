/**
 * The mtime a file written now would carry, as the server reads it.
 *
 * "Written after" is not "stamped after". A file's mtime comes from the
 * kernel's clock, which on Linux is coarse and can read a few milliseconds
 * behind `Date.now()`; and bun's `statSync().mtimeMs` drops the fraction of a
 * millisecond. A test whose server compares stamps — a run's files against
 * the run's start, a `.ydoc` against its bound file — waits on this, not on
 * the wall clock: `await waitFor(() => fsStampNow() > t)`.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fsStampNow(): number {
  const dir = mkdtempSync(join(tmpdir(), 'cw-fs-stamp-'));
  try {
    const probe = join(dir, 'probe');
    writeFileSync(probe, '');
    return statSync(probe).mtimeMs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
