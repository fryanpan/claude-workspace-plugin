/**
 * Where a remark-math equation starts and ends, so the parser holds its TeX
 * as one opaque run and the serializer writes back the bytes it read.
 *
 * Two forms, the two remark-math reads:
 *
 *   `$x_e$`, `$$x$$`     inline math. The text between the dollar runs is
 *                        never parsed for emphasis, links or escapes, so
 *                        `$a*b$ and $c*d$` is two equations, not an italic.
 *   `$$` … `$$`          display math: a fence of two or more dollars on a
 *                        line of its own, closed by a fence at least as long.
 *                        Blank lines inside are part of the equation.
 *
 * The rules are remark-math's (micromark-extension-math), measured against
 * remark-math 6 rather than recalled, with two places where this parser reads
 * LESS math than remark-math does. Both only ever leave text as text, so a
 * file still comes back byte for byte; what differs is whether the editor
 * draws an equation.
 *
 * - A single-dollar span whose TeX starts or ends with a space, or whose
 *   closing dollar is followed by a digit, is plain text. remark-math reads
 *   `$5 and $10` as the equation `5 and ` followed by `10`; prices are far
 *   more common in these docs than equations padded with spaces, and a
 *   meeting's notes are full of them. This is pandoc's rule.
 * - A `$$` fence with no closing fence is plain text. remark-math runs it to
 *   the end of the document, which would fold every block after a stray
 *   `$$5` into one equation and orphan every thread anchored in them.
 */

/** The `codeBlock` language a display equation is stored under. Its text is
 *  the equation's exact source lines, fences included — the same way an
 *  `.mdx` component is held (`MDX_FLOW_LANGUAGE`). */
export const MATH_DISPLAY_LANGUAGE = 'math-display';

/** What starts at a `$`: an equation, or a dollar run that is just text. */
export type MathTextRun =
  | { kind: 'math'; end: number; dollars: number }
  | { kind: 'text'; end: number };

function runLength(text: string, at: number): number {
  let n = 0;
  while (text[at + n] === '$') n++;
  return n;
}

/** True when the character at `at` is escaped by an odd run of backslashes. */
function escaped(text: string, at: number): boolean {
  let n = 0;
  while (text[at - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

/**
 * Read the dollar run at `text[i]`. Null when `i` is not the start of an
 * unescaped run, so the caller treats the character as ordinary text.
 *
 * `end` is where the caller resumes either way. A run with no closer is text
 * through its last dollar; a span this parser declines (the price rule above)
 * is text through its CLOSING dollar, because remark-math reads that whole
 * span as one equation, and starting a second one at its closer would draw
 * math where remark-math draws none.
 */
export function mathTextAt(text: string, i: number): MathTextRun | null {
  if (text[i] !== '$' || text[i - 1] === '$' || escaped(text, i)) return null;
  const dollars = runLength(text, i);
  let j = i + dollars;
  while (j < text.length) {
    if (text[j] !== '$') {
      // A blank line ends the paragraph the equation would have to sit in.
      if (text[j] === '\n' && text[j + 1] === '\n') break;
      j++;
      continue;
    }
    const len = runLength(text, j);
    if (len !== dollars) {
      j += len;
      continue;
    }
    const end = j + len;
    if (dollars === 1) {
      const tex = text.slice(i + 1, j);
      if (/^\s|\s$/.test(tex) || /\d/.test(text[end] ?? '')) return { kind: 'text', end };
    }
    return { kind: 'math', end, dollars };
  }
  return { kind: 'text', end: i + dollars };
}

const OPEN_FENCE = /^ {0,3}(\${2,})[^$]*$/;
const CLOSE_FENCE = /^ {0,3}(\${2,})[ \t]*$/;

/** The fence length when `line` opens a display equation, else 0. */
export function mathFenceOpen(line: string): number {
  return OPEN_FENCE.exec(line)?.[1]?.length ?? 0;
}

/** True when `line` closes a display equation opened by `open` dollars. */
export function mathFenceCloses(line: string, open: number): boolean {
  return (CLOSE_FENCE.exec(line)?.[1]?.length ?? 0) >= open;
}

/**
 * The index one past the closing fence of a display equation that opens at
 * `lines[i]`, or null when `lines[i]` opens none or nothing closes it.
 */
export function mathFlowEnd(lines: readonly string[], i: number): number | null {
  const open = mathFenceOpen(lines[i] ?? '');
  if (open === 0) return null;
  for (let k = i + 1; k < lines.length; k++) {
    if (mathFenceCloses(lines[k] ?? '', open)) return k + 1;
  }
  return null;
}

/** The TeX inside a display equation's source: the lines between its
 *  fences. Anything after the opening dollars is remark-math's `meta`, which
 *  it does not render either. */
export function mathDisplayTex(source: string): string {
  const lines = source.split('\n');
  return lines.slice(1, -1).join('\n');
}

/**
 * The dollar count an inline `math` mark stands for. The parser writes
 * `true` for one dollar and `{ dollars }` for more; the editor writes back
 * `{ dollars }` whatever it read.
 */
export function mathDollars(value: unknown): number {
  if (value && typeof value === 'object') {
    const n = (value as { dollars?: unknown }).dollars;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  }
  return 1;
}
