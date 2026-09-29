/**
 * The notes of a voice recording whose page went away, written by the server.
 *
 * While the page is open it writes each note itself, through the thread
 * routes (`voice-session.ts` in the widget). A page that is left — a link
 * followed, the tab closed, the browser quit — takes with it the words said
 * since the last pause, the tidy call still out, and any create or edit it had
 * not sent yet. The relay (`voice-feedback-relay.ts`) still holds all of
 * that, so when a socket closes without a Stop it finishes the notes and
 * hands them here, and this makes the doc's threads say what the relay says.
 *
 * ONE THREAD PER NOTE. A note is found before anything is written: by the
 * thread the page said it posted, else by its clip — a note's clip starts
 * where its words start (`seg-3.wav#t=12.4,`) and only its end moves as it
 * grows, so that prefix names one note of one recording. A note the page
 * posted without saying so before it went is found that way and edited, not
 * written a second time. Only a note no thread holds is created.
 *
 * WHERE A CREATED NOTE STANDS. The server never sees the page, so it cannot
 * build an anchor. A note about an element another note of this recording
 * stands on takes that note's anchor; any other lands on the page as a whole
 * (`subject`), which is where the widget puts a note about no element.
 */
import type { Anchor, Thread, User, VoiceNote, WriteVia } from '@claude-workspaces/core';
import { mayTouchFrom } from './mockup-frame.ts';
import type { Session } from './voice-feedback-session.ts';
import { clipPath } from './voice-feedback-store.ts';

/** A note as the relay ends it. */
export interface NoteToKeep {
  key: string;
  text: string;
  target: number | null;
  raw: string;
  clip: string;
  /** The thread the page said it posted this note as. */
  threadId?: string;
}

/** The slice of the doc store this needs. */
export interface VoiceNoteThreads {
  listThreads(docId: string): Thread[];
  postComment(
    docId: string,
    threadId: null,
    author: User,
    text: string,
    anchor: Anchor,
    opts: { voice: VoiceNote; via?: WriteVia },
  ): Promise<Thread | null>;
  editCommentText(
    docId: string,
    threadId: string,
    commentId: string,
    text: string,
    opts: { actor: User; voice: VoiceNote },
  ): { ok: boolean; error?: string };
}

export interface KeepRequest {
  docId: string;
  /** Who is speaking, when the socket or the page said; else the author of a
   *  note the page already posted. */
  author: User | null;
  via?: WriteVia;
  notes: NoteToKeep[];
}

export interface KeepResult {
  created: string[];
  edited: string[];
  /** Notes with words that no thread holds and nobody could be named for. */
  unwritten: string[];
}

interface Found {
  thread: Thread;
  commentId: string;
  text: string;
  voice: VoiceNote | undefined;
  author: User;
  via: WriteVia | undefined;
}

/** `…/seg-3.wav#t=12.4,31` → `…/seg-3.wav#t=12.4,` — the part a note keeps. */
export function clipStart(clip: string): string {
  return clip.slice(0, clip.lastIndexOf(',') + 1);
}

/** The comment holding this note: by its clip, which the server made, so a
 *  thread id the page reported can only narrow the search, never widen it. */
function locate(threads: Thread[], note: NoteToKeep): Found | null {
  const prefix = clipStart(note.clip);
  if (prefix === '') return null;
  const named = threads.filter((t) => t.id === note.threadId);
  for (const thread of [...named, ...threads]) {
    for (const c of thread.comments) {
      if (c.voice?.clip.startsWith(prefix)) {
        return {
          thread,
          commentId: c.id,
          text: c.text,
          voice: c.voice,
          author: c.author,
          via: c.via,
        };
      }
    }
  }
  return null;
}

export async function keepNotes(threads: VoiceNoteThreads, req: KeepRequest): Promise<KeepResult> {
  const out: KeepResult = { created: [], edited: [], unwritten: [] };
  const all = threads.listThreads(req.docId);
  const found = new Map<string, Found>();
  for (const n of req.notes) {
    const f = locate(all, n);
    if (f) found.set(n.key, f);
  }
  const author = req.author ?? [...found.values()][0]?.author ?? null;
  const anchorOn = (target: number | null): Anchor => {
    if (target !== null) {
      for (const n of req.notes) {
        const f = found.get(n.key);
        if (f && n.target === target && f.thread.anchor.kind !== 'orphan') return f.thread.anchor;
      }
    }
    return { kind: 'subject' };
  };
  for (const n of req.notes) {
    const text = n.text.trim();
    if (!text) continue;
    const voice: VoiceNote = { clip: n.clip, raw: n.raw };
    const f = found.get(n.key);
    if (f) {
      if (f.text === n.text && f.voice?.clip === n.clip && f.voice?.raw === n.raw) continue;
      // A mock's socket edits only what was written from inside the mock,
      // as a relayed edit through the thread routes does.
      if (!mayTouchFrom(req.via, f)) continue;
      const res = threads.editCommentText(req.docId, f.thread.id, f.commentId, n.text, {
        actor: author ?? f.author,
        voice,
      });
      if (res.ok) out.edited.push(n.key);
      continue;
    }
    if (!author) {
      out.unwritten.push(n.key);
      continue;
    }
    const t = await threads.postComment(req.docId, null, author, n.text, anchorOn(n.target), {
      voice,
      ...(req.via ? { via: req.via } : {}),
    });
    if (t) out.created.push(n.key);
    else out.unwritten.push(n.key);
  }
  return out;
}

/** A relay session's notes, kept, and what was done said in its log. */
export async function keepSession(threads: VoiceNoteThreads, s: Session): Promise<KeepResult> {
  const notes = [...s.comments.values()].map((c) => ({
    ...c,
    clip: clipPath(s.ws.data, s.segment, c.startMs, c.endMs),
  }));
  const kept = await keepNotes(threads, {
    docId: s.ws.data.docId,
    author: s.author,
    ...(s.ws.data.via ? { via: s.ws.data.via } : {}),
    notes,
  });
  const list = (keys: string[]) => keys.join(', ') || 'none';
  s.log.write(
    `- The page went; the server wrote its notes: created ${list(kept.created)}, edited ${list(kept.edited)}\n`,
  );
  if (kept.unwritten.length > 0) {
    s.log.write(`- Not written, no speaker known: ${list(kept.unwritten)}\n`);
  }
  return kept;
}
