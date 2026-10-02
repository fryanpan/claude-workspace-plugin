/**
 * Every Send Bryan made from the page, in `<dataDir>/inbox/sends.json`
 * (mode 600): the words he sent, where they went, and the answer the route
 * gave. Three readers, all in `reply.ts`: the nonce check (a repeat within a
 * day gets the first answer back and sends nothing), the hourly limit, and
 * nothing else. The sent text is message text under the body's rules: no
 * row read, event, log line or MCP tool carries it. Nothing here deletes.
 */
import { join } from 'node:path';
import { INBOX_DIRNAME } from './config.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import type { SendChannel } from './types.ts';

export const NONCE_WINDOW_MS = 24 * 3_600_000;
export const SEND_WINDOW_MS = 3_600_000;
/** At most this many sends in any hour. */
export const MAX_SENDS_PER_HOUR = 30;

export interface ReplyAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface SendRecord {
  rowId: string;
  nonce: string;
  at: number;
  channel: SendChannel;
  text: string;
  upstreamId?: string;
  answer: ReplyAnswer;
}

interface SendsFile {
  version: 1;
  sends: SendRecord[];
}

export class InboxSends {
  private readonly path: string;
  private file: SendsFile;
  readonly loadError: string | null;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.path = join(dataDir, INBOX_DIRNAME, 'sends.json');
    const read = readJsonFile<SendsFile>(this.path, { version: 1, sends: [] }, now());
    const sends = read.value?.sends;
    this.file = { version: 1, sends: Array.isArray(sends) ? sends : [] };
    this.loadError = read.error;
  }

  /** The answer a nonce got on this row within the last day. */
  answered(rowId: string, nonce: string, now: number): ReplyAnswer | undefined {
    return this.file.sends.find(
      (s) => s.rowId === rowId && s.nonce === nonce && now - s.at < NONCE_WINDOW_MS,
    )?.answer;
  }

  /** Sends that reached the source in the hour before `now`, failed or not. */
  inLastHour(now: number): number {
    return this.file.sends.filter((s) => now - s.at < SEND_WINDOW_MS).length;
  }

  record(rec: SendRecord): void {
    this.file.sends.push(rec);
    writeJsonFile(this.path, this.file);
  }
}
