/**
 * Which blocks one meeting wrote, kept for the whole meeting rather than for
 * one recording leg.
 *
 * WHY THE AUTHORSHIP MARK IS NOT ENOUGH. The note-taker stamps every block it
 * writes with `cwAuthor` = `meeting-notes`, and `notes-written.ts` reads a
 * meeting's notes off those marks. But every recording LEG releases every
 * mark when it starts (`releaseNotesAuthorship`), and a reconnect starts a
 * leg. So after a dropped socket the first leg's notes read as nobody's, and
 * the stop's notes check read only what the LAST leg wrote. On a person's own
 * doc, where the notes sit under the doc's headings rather than in a section
 * of the meeting's own, that was close to nothing: the check reported 100% of
 * what was said as reaching no note, while the timing record (which every leg
 * appends to) counted every note landing on time (2026-10-04).
 *
 * WHAT IS RECORDED. After every tick that wrote, and again at every leg's
 * stop, the ids of the blocks still carrying the mark are added to this
 * meeting's set. A mark standing at those moments is this leg's own, because
 * the leg released every older one when it started. The set only grows: a
 * block a person later deletes is simply not found in the doc, and a block a
 * person edits (which clears its mark) is still a note this meeting wrote.
 *
 * ON DISK BESIDE THE MEETING when there is a data dir, so a server restart
 * mid-meeting does not forget the first leg. It holds block ids only, no
 * words. Nothing here throws: a set that cannot be written is kept in memory,
 * and the reading falls back to the marks and the section, as before.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { meetingDirPath, meetingWrittenPath } from './meetings.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore, readNotesOutline } from './notes-doc-access.ts';

/** A meeting, as every file on this path names one. */
export interface WrittenBlocksIds {
  docId: string;
  meetingId: string;
}

/** The blocks each meeting has written, across all of its legs. */
export interface NotesWrittenBlocks {
  /** Add these block ids to the meeting's set. */
  add(ids: WrittenBlocksIds, blockIds: Iterable<string>): void;
  /** Every block id the meeting has written. Empty for one that wrote none. */
  read(ids: WrittenBlocksIds): ReadonlySet<string>;
  /** Every block id ANY meeting has recorded writing in this doc — what says
   *  a block is minutes rather than the person's own writing. */
  writtenInDoc(docId: string): ReadonlySet<string>;
}

/** The ids a record on disk holds; anything else in the file is ignored. */
function idsOf(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const blocks = (raw as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? blocks.filter((b): b is string => typeof b === 'string') : [];
}

/**
 * The set, cached in memory and mirrored to `<meetingId>-written.json` when a
 * data dir is given. Without one it lasts as long as the process.
 */
export function createNotesWrittenBlocks(dataDir?: string): NotesWrittenBlocks {
  const byMeeting = new Map<string, Set<string>>();
  const keyOf = ({ docId, meetingId }: WrittenBlocksIds): string => `${docId}::${meetingId}`;
  const load = (ids: WrittenBlocksIds): Set<string> => {
    const key = keyOf(ids);
    const held = byMeeting.get(key);
    if (held) return held;
    const set = new Set<string>();
    if (dataDir !== undefined) {
      const path = meetingWrittenPath(dataDir, ids.docId, ids.meetingId);
      try {
        if (existsSync(path))
          for (const id of idsOf(JSON.parse(readFileSync(path, 'utf8')))) set.add(id);
      } catch (err) {
        console.error(`[meeting-notes] written-blocks record unreadable at ${path}:`, err);
      }
    }
    byMeeting.set(key, set);
    return set;
  };
  return {
    add(ids, blockIds) {
      const set = load(ids);
      const before = set.size;
      for (const id of blockIds) set.add(id);
      if (set.size === before || dataDir === undefined) return;
      const path = meetingWrittenPath(dataDir, ids.docId, ids.meetingId);
      const tmp = `${path}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ ...ids, blocks: [...set] })}\n`);
        renameSync(tmp, path);
      } catch (err) {
        console.error(`[meeting-notes] written-blocks record not written at ${path}:`, err);
      }
    },
    read(ids) {
      return load(ids);
    },
    writtenInDoc(docId) {
      const out = new Set<string>();
      const meetings = new Set<string>();
      for (const key of byMeeting.keys()) {
        const [doc, meetingId] = key.split('::');
        if (doc === docId && meetingId !== undefined) meetings.add(meetingId);
      }
      if (dataDir !== undefined) {
        try {
          const dir = meetingDirPath(dataDir, docId);
          if (existsSync(dir)) {
            for (const name of readdirSync(dir)) {
              if (!name.endsWith('-written.json')) continue;
              const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
              for (const id of idsOf(raw)) out.add(id);
            }
          }
        } catch (err) {
          console.error(`[meeting-notes] written-blocks records unreadable for ${docId}:`, err);
        }
      }
      for (const meetingId of meetings) for (const id of load({ docId, meetingId })) out.add(id);
      return out;
    },
  };
}

/**
 * Add every block in the doc still carrying the note-taker's mark to this
 * meeting's set. Called after a tick wrote and at a leg's stop; total, so a
 * doc that cannot be read records nothing and costs the tick nothing.
 */
export function recordMarkedBlocks(
  written: NotesWrittenBlocks,
  docStore: NotesDocStore,
  ids: WrittenBlocksIds,
): void {
  try {
    const marked = readNotesOutline(docStore, ids.docId)
      .filter((e) => e.author === NOTES_AUTHOR_ID)
      .map((e) => e.id);
    written.add(ids, marked);
  } catch (err) {
    console.error('[meeting-notes] written-blocks record failed:', err);
  }
}
