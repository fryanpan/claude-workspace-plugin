import {
  MATH_DISPLAY_LANGUAGE,
  mathFenceCloses,
  mathFenceOpen,
  mathTextAt,
} from '@claude-workspaces/core/prose-math';

/**
 * remark-math equations for the markdown-it parser inside `tiptap-markdown`.
 *
 * The server's parser (`core/prose-markdown.ts`) is what a doc is built from;
 * markdown-it is the OTHER parser in the client, and it runs wherever markdown
 * reaches an editor without passing through the server — a redline renders
 * every block of a diff through it, and the doc editor parses pasted markdown
 * with it. Without these rules it reads `$a*b$ and $c*d$` as an italic, so a
 * diff of a doc full of equations was drawn as prose. Both rules call the same
 * boundary functions the server's parser does (`core/prose-math.ts`), so the
 * two parsers cannot disagree about where an equation is.
 *
 * Inline math becomes `<span data-cw-math="n">` (the `math` mark's own HTML,
 * `math-inline.ts`); display math becomes the code block the server stores it
 * as.
 */

interface MdToken {
  content: string;
  meta: unknown;
}
interface InlineState {
  src: string;
  pos: number;
  posMax: number;
  pending: string;
  push(type: string, tag: string, nesting: number): MdToken;
}
interface BlockState {
  src: string;
  line: number;
  blkIndent: number;
  sCount: number[];
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(type: string, tag: string, nesting: number): MdToken & { map: number[] | null };
}
interface Ruler<S> {
  __find__(name: string): number;
  before(
    before: string,
    name: string,
    fn: (state: S, ...rest: never[]) => boolean,
    opts?: { alt: string[] },
  ): void;
}
export interface MarkdownItLike {
  inline: { ruler: Ruler<InlineState> };
  block: { ruler: Ruler<BlockState> };
  renderer: {
    rules: Record<string, (tokens: MdToken[], idx: number) => string>;
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineRule(state: InlineState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x24) return false;
  const run = mathTextAt(state.src, state.pos);
  if (!run || run.end > state.posMax) return false;
  if (run.kind === 'text') {
    // A declined span is text through its closer — never a second opener.
    if (!silent) state.pending += state.src.slice(state.pos, run.end);
  } else if (!silent) {
    const token = state.push('cw_math_inline', 'span', 0);
    token.content = state.src.slice(state.pos + run.dollars, run.end - run.dollars);
    token.meta = run.dollars;
  }
  state.pos = run.end;
  return true;
}

function blockRule(state: BlockState, start: number, end: number, silent: boolean): boolean {
  if ((state.sCount[start] ?? 0) - state.blkIndent >= 4) return false;
  const line = (k: number) => state.getLines(k, k + 1, state.blkIndent, false);
  const first = line(start);
  const open = mathFenceOpen(first);
  if (open === 0) return false;
  const source = [first];
  let k = start + 1;
  for (; k < end; k++) {
    source.push(line(k));
    if (mathFenceCloses(line(k), open)) break;
  }
  // Unclosed: text, as in the server's parser.
  if (k >= end) return false;
  if (silent) return true;
  const token = state.push('cw_math_block', 'pre', 0);
  token.content = source.join('\n');
  token.map = [start, k + 1];
  state.line = k + 1;
  return true;
}

/** Install both rules. Called on every parse, so it is idempotent. */
export function installMathRules(md: MarkdownItLike): void {
  if (md.inline.ruler.__find__('cw_math_inline') >= 0) return;
  md.inline.ruler.before('escape', 'cw_math_inline', inlineRule);
  md.block.ruler.before('fence', 'cw_math_block', blockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.cw_math_inline = (tokens, idx) => {
    const t = tokens[idx];
    return t ? `<span data-cw-math="${Number(t.meta) || 1}">${escapeHtml(t.content)}</span>` : '';
  };
  md.renderer.rules.cw_math_block = (tokens, idx) => {
    const t = tokens[idx];
    return t
      ? `<pre><code class="language-${MATH_DISPLAY_LANGUAGE}">${escapeHtml(t.content)}</code></pre>\n`
      : '';
  };
}
