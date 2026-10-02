/**
 * The two inbox files' read and write: owner-only, written whole through a
 * temp file and a rename so a crash mid-write leaves the old file intact.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The parsed file, or `fallback` when there is none. A file that does not
 *  parse is moved aside rather than overwritten, and the reason returned. */
export function readJsonFile<T>(
  path: string,
  fallback: T,
  now: number,
): { value: T; error: string | null } {
  if (!existsSync(path)) return { value: fallback, error: null };
  try {
    chmodSync(path, FILE_MODE);
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T, error: null };
  } catch (e) {
    const aside = `${path}.corrupt-${now}`;
    try {
      renameSync(path, aside);
    } catch {
      // The error below still names the file.
    }
    return { value: fallback, error: `${(e as Error).message} (moved aside to ${aside})` };
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, path);
}
