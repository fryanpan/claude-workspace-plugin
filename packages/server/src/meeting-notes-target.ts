/**
 * Which doc a meeting's notes go into.
 *
 * A MEETING ON A PERSON'S OWN DOC WRITES ITS NOTES TO A NEW DOC. Whole-doc
 * note-taking files each note "under the heading of its topic, wherever in
 * the document that heading is", which on a doc somebody wrote means the
 * notes land among their paragraphs. The owner, 2026-10-04: "Put them in a
 * separate doc and don't mess up my original doc." So when a recording starts
 * on a doc that holds a person's writing, the note-taker mints a notes doc,
 * adds one line to the original linking to it, and writes every note there.
 * The original's existing blocks are not touched.
 *
 * WHAT COUNTS AS A PERSON'S OWN WRITING: any block with text that is not a
 * heading, does not carry the note-taker's authorship mark, and is not a
 * block any meeting on this doc recorded writing (`notes-written-blocks.ts`).
 * Headings alone do not count, so a new doc holding only its title, a huddle
 * seeded with its topic, and a calendar meeting doc seeded with the event
 * title all keep today's behaviour. A huddle or a calendar meeting's doc
 * (an alias `meetingDocAlias` minted) never redirects whatever it holds: it exists to be a
 * meeting's notes, and notes written there before this release, or after a
 * stop, carry no record and would otherwise read as a person's writing.
 *
 * THE PLANNING INTERVIEW IS NOT A NOTES MEETING. `spoken-reply/interview.ts`
 * writes answers into a doc's own sections on purpose and never comes through
 * this path, so it is untouched.
 *
 * DECIDED ONCE PER MEETING, on its first leg, and recorded beside the meeting
 * (`<meetingId>-notes-doc.json`). A resumed leg reads the record back rather
 * than deciding again: by then the first leg's notes sit in whichever doc it
 * chose, and a meeting that switched doc between legs would split one
 * conversation across two.
 *
 * A PAGE THAT CAN FOLLOW IS SENT THERE INSTEAD (`handOff`). The doc page asks
 * at its Record press; on a doc holding a person's writing the relay answers
 * with the notes doc and opens no meeting, and the page records on the notes
 * doc, so the notes land in the editor the person is watching. Everything
 * above is how every other starter (the Recall bot, an older client, a
 * mic-plus-Mac-audio capture) gets the same result.
 *
 * NOTHING HERE THROWS. A notes doc that cannot be minted leaves the meeting
 * writing where it was started, which is what every meeting did before.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentKind, type prose } from '@claude-workspaces/core';
import { isMeetingDocAlias, meetingDocAlias, meetingDocFilePath } from './huddle.ts';
import { docLookupUrl } from './meeting-lookup.ts';
import type { MeetingTitleStore } from './meeting-titler.ts';
import { meetingNotesDocPath } from './meetings.ts';
import {
  NOTES_AUTHOR_ID,
  type NotesDocMeta,
  type NotesDocStore,
  applyNotesBlockEdits,
  readNotesOutline,
} from './notes-doc-access.ts';
import type { NotesWrittenBlocks } from './notes-written-blocks.ts';

/** A meeting, as every file on this path names one. */
export interface NotesTargetIds {
  docId: string;
  meetingId: string;
}

/**
 * Make a notes doc for a meeting on `source`. Returns the new doc's id and
 * the link the original doc carries, or `undefined` when no doc could be made.
 * The server's version creates a markdown doc bound to a file under the data
 * dir and files it on the source doc's board.
 */
export type NotesDocMint = (source: {
  docId: string;
  title?: string;
}) => { docId: string; title: string; url: string } | undefined;

/** Whether the doc holds writing that is not a heading and is not minutes. */
export function holdsOwnWriting(
  outline: readonly prose.OutlineEntry[],
  minutes: ReadonlySet<string>,
): boolean {
  return outline.some(
    (e) =>
      e.kind !== 'heading' &&
      // A list's own entry repeats its items' words; the items are judged.
      e.nodeName !== 'bulletList' &&
      e.nodeName !== 'orderedList' &&
      e.text.trim() !== '' &&
      e.author !== NOTES_AUTHOR_ID &&
      !minutes.has(e.id),
  );
}

/** The one line the original doc gains. */
export function notesLinkMarkdown(title: string, url: string): string {
  return `Meeting notes: [${title.replace(/[[\]]/g, '')}](${url})`;
}

export interface NotesTargets {
  /** A recording leg is starting: decide (first leg) or recall (a resume)
   *  where this meeting writes. Call before the marks are released. */
  begin(ids: NotesTargetIds): void;
  /** The doc a meeting started on `docId` is writing into now. */
  targetOf(docId: string): string;
  /** `base`, with every doc id mapped to the doc its meeting writes into. */
  store(base: NotesDocStore): NotesDocStore;
  /** The same mapping over the title store, so the meeting namer names the
   *  doc the notes are in and never the person's own. */
  titles(base: MeetingTitleStore): MeetingTitleStore;
  /**
   * A page is about to record on `docId` and can open another doc instead.
   * When the doc holds a person's writing, mint the notes doc, link it from
   * the original, and answer where it is, so the page records THERE and the
   * notes land in the editor the person is watching. `undefined` means record
   * here, as before. No meeting exists yet, so nothing is recorded per
   * meeting: the meeting that follows runs on the notes doc, a huddle, which
   * writes in place. A second press on the same doc inside `HANDOFF_REUSE_MS`,
   * or while `recording` says the notes doc is live, is answered with the
   * same notes doc.
   */
  handOff(docId: string, recording?: (docId: string) => boolean): NotesDocHandoff | undefined;
}

/** Where a page should record instead: the notes doc it just got. */
export interface NotesDocHandoff {
  docId: string;
  title: string;
  url: string;
}

/** What one record holds: the notes doc, or `null` for "writes in place". */
interface NotesDocRecord {
  notesDocId: string | null;
}

/**
 * Which doc a meeting's notes went to, as its first leg recorded it: the
 * notes doc's id, `null` for "in place", `undefined` for no record. Read from
 * disk, so it answers after a restart — which is why the tidy-up route reads
 * this and not the in-process map.
 */
export function readNotesDocRecord(
  dataDir: string,
  ids: NotesTargetIds,
): string | null | undefined {
  const path = meetingNotesDocPath(dataDir, ids.docId, ids.meetingId);
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NotesDocRecord>;
    return typeof raw.notesDocId === 'string' ? raw.notesDocId : null;
  } catch (err) {
    console.error(`[meeting-notes] notes-doc record unreadable at ${path}:`, err);
    return undefined;
  }
}

/** `base`, with every doc id read and written as the doc `at` maps it to. */
export function redirectNotesStore(
  base: NotesDocStore,
  at: (docId: string) => string,
): NotesDocStore {
  return {
    get: (docId) => base.get(at(docId)),
    readOutline: (docId, opts) => base.readOutline(at(docId), opts),
    applyBlockEdits: (docId, edits, who) => base.applyBlockEdits(at(docId), edits, who),
    ...(base.boundPathOf ? { boundPathOf: (docId: string) => base.boundPathOf?.(at(docId)) } : {}),
  };
}

/** How long a hand-off on a doc is reused rather than minting another. */
export const HANDOFF_REUSE_MS = 10 * 60_000;

/** A huddle or a calendar meeting's doc: its writing IS a meeting's notes, so
 *  it keeps them. The alias must be one `meetingDocAlias` minted, not merely
 *  start `meeting-`: a person's own doc can be named that. */
function isMeetingDoc(meta: NotesDocMeta): boolean {
  return meta.huddle === true || (meta.alias !== undefined && isMeetingDocAlias(meta.alias));
}

export function createNotesTargets(deps: {
  docStore: () => NotesDocStore;
  written: NotesWrittenBlocks;
  mint?: NotesDocMint;
  dataDir?: string;
  now?: () => number;
}): NotesTargets {
  const now = deps.now ?? Date.now;
  // The last hand-off per doc. A second Record press on the same doc inside
  // the window — another tab, a retry after a drop, Back and Record again —
  // goes to the notes doc the first one made, where the doc's one-recorder
  // claim refuses a second recording, instead of minting another notes doc
  // and adding another link line.
  const handedOff = new Map<string, { to: NotesDocHandoff; at: number }>();
  // Per meeting: what the first leg decided. Per doc: what the meeting
  // recording on it now writes into. The store wrapper is keyed by doc only,
  // because every `NotesDocStore` call is.
  const decided = new Map<string, string | null>();
  const current = new Map<string, string>();
  const keyOf = ({ docId, meetingId }: NotesTargetIds): string => `${docId}::${meetingId}`;

  const readRecord = (ids: NotesTargetIds): string | null | undefined => {
    const held = decided.get(keyOf(ids));
    if (held !== undefined) return held;
    if (deps.dataDir === undefined) return undefined;
    return readNotesDocRecord(deps.dataDir, ids);
  };
  const writeRecord = (ids: NotesTargetIds, notesDocId: string | null): void => {
    decided.set(keyOf(ids), notesDocId);
    if (deps.dataDir === undefined) return;
    const path = meetingNotesDocPath(deps.dataDir, ids.docId, ids.meetingId);
    const tmp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify({ ...ids, notesDocId, at: Date.now() })}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[meeting-notes] notes-doc record not written at ${path}:`, err);
    }
  };

  /** Mint the notes doc and link it, or `null` to write in place. `ids`
   *  names the meeting the link is recorded against, when there is one. */
  const mintFor = (
    docId: string,
    ids?: NotesTargetIds,
  ): { docId: string; title: string; url: string } | null => {
    if (!deps.mint) return null;
    const base = deps.docStore();
    const doc = base.get(docId);
    if (!doc || isMeetingDoc(doc.meta) || contentKind(doc.meta.type) !== 'prose') return null;
    const before = readNotesOutline(base, docId);
    if (!holdsOwnWriting(before, deps.written.writtenInDoc(docId))) return null;
    const minted = deps.mint({
      docId,
      ...(doc.meta.title !== undefined ? { title: doc.meta.title } : {}),
    });
    if (minted === undefined) return null;
    const linked = applyNotesBlockEdits(base, docId, [
      { op: 'insert_at_end', markdown: notesLinkMarkdown(minted.title, minted.url) },
    ]);
    if (!linked.ok) {
      console.error(`[meeting-notes] notes-doc link not written in ${docId}`);
    } else {
      // The link is the meeting's own line, so a later meeting on this doc
      // does not read it as the person's writing. A hand-off has no meeting
      // yet, so its link is recorded under the notes doc's id, which no
      // meeting on the original ever uses.
      const known = new Set(before.map((e) => e.id));
      const added = readNotesOutline(base, docId)
        .filter((e) => !known.has(e.id))
        .map((e) => e.id);
      deps.written.add(ids ?? { docId, meetingId: `handoff-${minted.docId}` }, added);
    }
    return minted;
  };
  const decide = (ids: NotesTargetIds): string | null => mintFor(ids.docId, ids)?.docId ?? null;

  const targetOf = (docId: string): string => current.get(docId) ?? docId;
  return {
    begin(ids) {
      let notesDocId = readRecord(ids);
      if (notesDocId === undefined) {
        try {
          notesDocId = decide(ids);
        } catch (err) {
          console.error(`[meeting-notes] notes-doc decision failed for ${ids.docId}:`, err);
          notesDocId = null;
        }
        writeRecord(ids, notesDocId);
      }
      if (notesDocId === null) current.delete(ids.docId);
      else current.set(ids.docId, notesDocId);
    },
    targetOf,
    handOff(docId, recording) {
      const last = handedOff.get(docId);
      if (last && (now() - last.at < HANDOFF_REUSE_MS || recording?.(last.to.docId) === true)) {
        // The window runs from the last press, so Record again a minute
        // after a long meeting stops still finds its notes doc.
        last.at = now();
        return last.to;
      }
      try {
        const to = mintFor(docId) ?? undefined;
        if (to) handedOff.set(docId, { to, at: now() });
        return to;
      } catch (err) {
        console.error(`[meeting-notes] notes-doc hand-off failed for ${docId}:`, err);
        return undefined;
      }
    },
    store(base) {
      return redirectNotesStore(base, targetOf);
    },
    titles(base) {
      return {
        get: (docId) => base.get(targetOf(docId)),
        readMarkdownBody: (docId) => base.readMarkdownBody(targetOf(docId)),
        setAutoTitle: (docId, title, source, opts) =>
          base.setAutoTitle(targetOf(docId), title, source, opts),
        list: () => base.list(),
      };
    },
  };
}

/** The slice of the server the real mint needs. Structural, so a test can
 *  hand in a fake and this module imports no store. */
export interface NotesDocMintHost {
  createForCaller(
    requested: string,
    init: { type: 'markdown'; title: string; titleSource: 'given'; huddle: true },
  ): { ok: true; doc: { docId: string }; minted: boolean } | { ok: false };
  attachFile(docId: string, filePath: string): { ok: boolean };
  /** Files the doc on a board and answers which one. */
  fileUnderBoard(docId: string, requested?: string): string;
  /** The board the source doc lives on, when it has one. */
  boardOf(docId: string): string | undefined;
}

/**
 * The server's mint: a huddle doc titled after the source, bound to a file
 * under the data dir the way a calendar meeting's doc is, and filed on the
 * source doc's board. A huddle, so a meeting started on the notes doc itself
 * keeps writing there.
 */
export function createServerNotesDocMint(
  host: NotesDocMintHost,
  dataDir: string,
  now: () => number = Date.now,
): NotesDocMint {
  return (source) => {
    const title = `${source.title?.trim() || 'Untitled'} — meeting notes`;
    const init = { type: 'markdown', title, titleSource: 'given', huddle: true } as const;
    try {
      const created = host.createForCaller(meetingDocAlias(now()), init);
      if (!created.ok || !created.minted) return undefined;
      const docId = created.doc.docId;
      const file = meetingDocFilePath(dataDir, docId);
      mkdirSync(dirname(file), { recursive: true });
      // Empty, like a huddle with no topic: the title is the doc's own and the
      // page shows it as the heading, so a `# title` line would show it twice.
      if (!existsSync(file)) writeFileSync(file, '');
      if (!host.attachFile(docId, file).ok) return undefined;
      const workspaceId = host.fileUnderBoard(docId, host.boardOf(source.docId));
      return { docId, title, url: docLookupUrl(workspaceId, docId) };
    } catch (err) {
      console.error(`[meeting-notes] notes doc not minted for ${source.docId}:`, err);
      return undefined;
    }
  };
}
