/**
 * The message text, apart from the rows.
 *
 * A row says who wrote and what they want; the body is what they actually
 * wrote, and it is the most hostile text on this server. So it has its own
 * file (`<dataDir>/inbox/bodies.json`, mode 600), keyed by row id, and only
 * two callers: the reader's post writes it, and the owner-only body route
 * reads it. No row read, event, log line or MCP tool carries it. A body is
 * replaced when its thread is re-posted and never deleted.
 */
import { join } from 'node:path';
import { INBOX_DIRNAME } from './config.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';

interface BodiesFile {
  version: 1;
  bodies: Record<string, string>;
}

export class InboxBodies {
  private readonly path: string;
  private file: BodiesFile;
  readonly loadError: string | null;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.path = join(dataDir, INBOX_DIRNAME, 'bodies.json');
    const read = readJsonFile<BodiesFile>(this.path, { version: 1, bodies: {} }, now());
    const bodies = read.value?.bodies;
    this.file = { version: 1, bodies: bodies && typeof bodies === 'object' ? bodies : {} };
    this.loadError = read.error;
  }

  get(rowId: string): string | undefined {
    const b = Object.hasOwn(this.file.bodies, rowId) ? this.file.bodies[rowId] : undefined;
    return typeof b === 'string' ? b : undefined;
  }

  /** Set every body in one write. */
  putAll(entries: ReadonlyArray<readonly [rowId: string, body: string]>): void {
    if (entries.length === 0) return;
    for (const [id, body] of entries) this.file.bodies[id] = body;
    writeJsonFile(this.path, this.file);
  }
}
