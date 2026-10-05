import type { ElementAnchor } from './types.ts';

/**
 * A change a person made to the words on a page, sent to the agent that
 * builds the page rather than written into it.
 *
 * The widget's edit mode lets a reviewer retype text on a mock or on a dev
 * server in place. It never writes the page's source: the page may be a
 * generator's output, or a dev server this server cannot read at all. What it
 * records is the element, the words it showed and the words the reviewer
 * wants, and it posts them on the page's thread as the first comment's
 * `pageEdits`. The agent applies each one to its own source and resolves the
 * thread; an open thread is an edit still waiting, a resolved one an edit
 * applied.
 *
 * Words and their inline marks only: `after` is a small markdown — blocks
 * joined by a blank line, bold, italic, code and links
 * (`page-edits-text.ts`) — and carries no style and no image. `before` is
 * the element's plain words.
 */
export interface PageEdit {
  /** The element, fingerprinted the way a comment pin is, so the page can
   *  find it again after a reload and mark it. */
  anchor: ElementAnchor;
  /** A short CSS path, readable by the agent looking for the node in its own
   *  template: the last few steps, without structural wrappers. */
  selector: string;
  /** The element's words as the page showed them. */
  before: string;
  /** What the reviewer wants there, as markdown (`page-edits-text.ts`).
   *  Empty means the words were deleted. */
  after: string;
}

/** The most edits one send may carry. */
export const MAX_PAGE_EDITS = 50;
/** The most characters `before` or `after` may hold. Longer is refused, not
 *  cut: half an edit applied is a wrong edit. */
export const MAX_PAGE_EDIT_TEXT = 4000;
/** The longest `selector`. */
export const MAX_PAGE_EDIT_SELECTOR = 300;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Every field the page's resolver reads to find the element again. A
 *  fingerprint missing one would reach `resolve` on the reviewer's page. */
function isElementAnchor(v: unknown): v is ElementAnchor {
  if (!isRecord(v) || v.kind !== 'element') return false;
  const fp = v.fingerprint;
  return (
    isRecord(fp) &&
    typeof fp.tag === 'string' &&
    typeof fp.text === 'string' &&
    typeof fp.path === 'string' &&
    Array.isArray(fp.classes) &&
    isRecord(fp.stableAttrs) &&
    isRecord(fp.dataAttrs) &&
    isRecord(v.snippet) &&
    typeof v.snippet.text === 'string'
  );
}

const okText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PAGE_EDIT_TEXT;

/**
 * The edits on a stored or posted comment, or nothing.
 *
 * Read as defensively as the other notes a comment carries: this value is
 * written by whatever peer posted it, so a malformed entry is dropped rather
 * than reaching a renderer or an agent, and an empty list reads as absent so
 * an ordinary comment keeps exactly the shape it always had. The server
 * additionally validates each anchor before it stores one.
 */
export function readPageEdits(raw: unknown): PageEdit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PageEdit[] = [];
  for (const e of raw) {
    if (out.length === MAX_PAGE_EDITS) break;
    if (!e || typeof e !== 'object') continue;
    const { anchor, selector, before, after } = e as Record<string, unknown>;
    if (!isElementAnchor(anchor)) continue;
    if (typeof selector !== 'string' || selector === '') continue;
    if (selector.length > MAX_PAGE_EDIT_SELECTOR) continue;
    // `after` equal to `before` is not a no-op: `before` is plain words and
    // `after` markdown, so it is bold or a link taken off them.
    if (!okText(before) || !okText(after)) continue;
    out.push({ anchor, selector, before, after });
  }
  return out.length > 0 ? out : undefined;
}

export { pageEditsText } from './page-edits-text.ts';

/**
 * A change an AGENT proposes to the words on a page, for the reader to take
 * or leave where the words are.
 *
 * The agent cannot see the page, so it names the words rather than the
 * element: `find` is text the page shows, and the thread's anchor finds the
 * element that says it (`createWordsAnchor`). Accept turns it into the
 * `PageEdit` a pencil send carries (`suggestedEdit`), so the agent hears it
 * the way it hears the reader's own edits; Reject resolves the thread.
 */
export interface PageSuggestion {
  /** The words on the page to replace. */
  find: string;
  /** What to put in their place. Empty deletes them. */
  replacement: string;
}

/** The longest `find` an agent may anchor by. */
export const MAX_PAGE_FIND = 300;

/** Words as a reader sees them: runs of whitespace are one space. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A stored or posted suggestion, or nothing. Read as defensively as
 *  `readPageEdits`, and refused rather than cut when too long. */
export function readPageSuggestion(raw: unknown): PageSuggestion | undefined {
  if (!isRecord(raw)) return undefined;
  const { find, replacement } = raw;
  if (typeof find !== 'string' || norm(find) === '' || find.length > MAX_PAGE_FIND)
    return undefined;
  if (!okText(replacement) || norm(replacement) === norm(find)) return undefined;
  return { find, replacement };
}

/** A comment's `pageSuggestion` field, spread-ready: `{}` when there is none. */
export function readSuggestionField(raw: unknown): { pageSuggestion?: PageSuggestion } {
  const pageSuggestion = readPageSuggestion(raw);
  return pageSuggestion ? { pageSuggestion } : {};
}

/**
 * The page edit an accepted suggestion is: the element's words with the
 * first occurrence of `find` replaced. Null when the element no longer says
 * `find`, or the change would leave its words as they were.
 */
export function suggestedEdit(at: Omit<PageEdit, 'after'>, s: PageSuggestion): PageEdit | null {
  const before = norm(at.before);
  const find = norm(s.find);
  const i = before.indexOf(find);
  if (i < 0) return null;
  const after = norm(before.slice(0, i) + s.replacement + before.slice(i + find.length));
  return after === before ? null : { ...at, before, after };
}
