import type { PageEdit } from './page-edits.ts';

/**
 * The words a person reads for a page-edit send, and the small markdown an
 * edit's `after` is written in.
 *
 * `after` is markdown: blocks joined by a blank line, `**bold**`, `*italic*`,
 * `` `code` `` and `[text](url)`, with `\` before a literal `*`, `[`, `]`,
 * `` ` `` or `\`. The widget writes it from the element the reviewer edited
 * (`widget/src/edit/edit-markdown.ts`) and reads it back here; nothing else
 * of markdown is produced, so nothing else is parsed.
 *
 * The comment's text is for a person: one short line saying what was
 * edited, then each change as a word diff — deleted words `~~struck~~`,
 * new ones `**bold**`, a few words of context either side. Selectors and the
 * whole before and after stay on `pageEdits`, where the agent reads them.
 */

/** A run of `after` with the marks it wears. */
export interface MdSpan {
  text: string;
  b?: true;
  i?: true;
  code?: true;
  href?: string;
}

type Marks = Omit<MdSpan, 'text'>;

/** Where the `d` that closes a run opened at `from` sits, or -1. A single
 *  `*` skips the `**` pairs inside it, and a `**` is the last of a run of
 *  stars, so `***x***` is bold around italic. */
function closer(s: string, d: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s.startsWith('**', k) && d === '*') k++;
    else if (s.startsWith(d, k) && s[k + d.length] !== '*' && k > from) return k;
  }
  return -1;
}

/** One block of `after` as runs of text. */
export function mdSpans(s: string, marks: Marks = {}): MdSpan[] {
  const out: MdSpan[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ ...marks, text: buf });
    buf = '';
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i] as string;
    if (c === '\\' && i + 1 < s.length) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ ...marks, code: true, text: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (c === '*') {
      const d = s.startsWith('**', i) ? '**' : '*';
      const j = closer(s, d, i + d.length);
      if (j > 0) {
        flush();
        out.push(
          ...mdSpans(s.slice(i + d.length, j), { ...marks, [d === '**' ? 'b' : 'i']: true }),
        );
        i = j + d.length;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push(...mdSpans(m[1] as string, { ...marks, href: m[2] as string }));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** The blocks of an `after`, as a reader sees them. */
export const mdBlocks = (md: string): string[] =>
  md.split(/\n\s*\n/).map((b) =>
    mdSpans(b.trim())
      .map((s) => s.text)
      .join(''),
  );

/** An `after`'s words without its marks: what the page shows once the agent
 *  has applied it, blocks run together. */
export const mdPlain = (md: string): string => mdBlocks(md).join(' ').replace(/\s+/g, ' ').trim();

/** Where a new paragraph starts, in a word diff. */
const PARA = '¶';
/** Words of unchanged context kept either side of a change. */
const CONTEXT = 4;
/** The most words one diff line shows. */
const LINE_WORDS = 60;

type Op = [0 | 1 | 2, string];

/** The words of `a` and `b` as kept (0), deleted (1) and inserted (2), by
 *  longest common subsequence after the shared ends are taken off. A middle
 *  too large to compare word by word is one deletion and one insertion. */
function wordDiff(a: string[], b: string[]): Op[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const x = a.slice(p, a.length - q);
  const y = b.slice(p, b.length - q);
  const keep = (w: string): Op => [0, w];
  const mid: Op[] = [];
  if (x.length * y.length > 250_000) {
    for (const w of x) mid.push([1, w]);
    for (const w of y) mid.push([2, w]);
  } else {
    const n = x.length;
    const m = y.length;
    const t = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * (m + 1) + j] =
          x[i] === y[j]
            ? (t[(i + 1) * (m + 1) + j + 1] as number) + 1
            : Math.max(t[(i + 1) * (m + 1) + j] as number, t[i * (m + 1) + j + 1] as number);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        mid.push([0, x[i++] as string]);
        j++;
      } else if (
        j < m &&
        (i === n || (t[i * (m + 1) + j + 1] as number) > (t[(i + 1) * (m + 1) + j] as number))
      )
        mid.push([2, y[j++] as string]);
      else mid.push([1, x[i++] as string]);
    }
  }
  return [...a.slice(0, p).map(keep), ...mid, ...b.slice(b.length - q).map(keep)];
}

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** One edit as a line of its word diff, context trimmed at word ends. */
export function diffLine(before: string, after: string): string {
  const now = mdBlocks(after)
    .map(words)
    .filter((b) => b.length > 0);
  const b = now.flatMap((w, k) => (k === 0 ? w : [PARA, ...w]));
  const ops = wordDiff(words(before), b);
  if (!ops.some(([o]) => o !== 0)) return `Formatting: ${b.slice(0, LINE_WORDS).join(' ')}`;
  const near = ops.map((_, k) =>
    ops.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some(([o]) => o !== 0),
  );
  const out: string[] = [];
  let n = 0;
  for (let k = 0; k < ops.length && n < LINE_WORDS; ) {
    const op = (ops[k] as Op)[0];
    if (!near[k]) {
      if (out.at(-1) !== '…') out.push('…');
      k++;
      continue;
    }
    const run: string[] = [];
    while (k < ops.length && (ops[k] as Op)[0] === op && near[k] && n < LINE_WORDS) {
      run.push((ops[k++] as Op)[1]);
      n++;
    }
    const text = run.join(' ');
    out.push(op === 0 ? text : op === 1 ? `~~${text}~~` : `**${text}**`);
  }
  if (n === LINE_WORDS && out.at(-1) !== '…') out.push('…');
  return out.join(' ');
}

const NOUNS: Record<string, string> = {
  P: 'paragraph',
  LI: 'list item',
  FIGCAPTION: 'caption',
  BLOCKQUOTE: 'quote',
  A: 'link',
  BUTTON: 'button',
  TD: 'table cell',
  TH: 'table cell',
};

const noun = (tag: string): string => (/^H[1-6]$/.test(tag) ? 'heading' : (NOUNS[tag] ?? 'text'));

/** "Edited 3 paragraphs and 1 heading" — what kinds of text, how many. */
function head(edits: readonly PageEdit[]): string {
  const counts = new Map<string, number>();
  for (const e of edits) {
    const k = noun(e.anchor.fingerprint.tag.toUpperCase());
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts].map(([k, c]) =>
    k === 'text'
      ? `${c} ${c === 1 ? 'piece' : 'pieces'} of text`
      : `${c} ${k}${c === 1 ? '' : 's'}`,
  );
  const last = parts.pop() as string;
  return `Edited ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}

/**
 * The comment's words for a send: what was edited, then each change as a
 * word diff, one line an edit.
 *
 * Written by the server from the edits themselves, so every surface that
 * shows a thread — the board, the doc page, the Home queue, an agent's
 * channel line — says the same thing the structure does.
 */
export function pageEditsText(edits: readonly PageEdit[]): string {
  return [head(edits), ...edits.map((e) => `- ${diffLine(e.before, e.after)}`)].join('\n');
}
