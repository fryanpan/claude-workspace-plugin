import { type MdSpan, mdSpans } from '@claude-workspaces/core/page-edits-text';

/**
 * An edited element as the markdown an edit's `after` carries, and back.
 *
 * The format is `core/src/page-edits-text.ts`: blocks joined by a blank
 * line, `**bold**`, `*italic*`, `` `code` `` and `[text](url)`. A line break
 * the reviewer typed, or a block the browser made inside the element, starts
 * a new block. Any other markup keeps its words and loses its look.
 */

/** Where one block ends and the next starts, while the text is built. */
const BREAK = ' ';
/** Elements that are a block of their own when they turn up inside the one
 *  being edited — the browser makes a `div` when Enter splits a line. */
const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|PRE|H[1-6])$/;
/** Elements whose content is not words on the page. */
const SKIP = /^(SVG|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|IMG|PICTURE|VIDEO|AUDIO|CANVAS)$/;

/** A link the edit may carry: anything but a script or inline data. */
const safeHref = (href: string | null): href is string =>
  !!href && !/^\s*(javascript|data|vbscript):/i.test(href);

const escape = (s: string): string => s.replace(/[\\`*[\]]/g, '\\$&');

/** `body` between `d` and `d`, per block, with its edge spaces outside. */
function wrap(body: string, d: string): string {
  return body
    .split(BREAK)
    .map((b) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(b) as RegExpExecArray;
      return m[2] ? `${m[1]}${d}${m[2]}${d}${m[3]}` : b;
    })
    .join(BREAK);
}

function md(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return escape(n.textContent ?? '');
  if (!(n instanceof Element)) return '';
  const tag = n.tagName.toUpperCase();
  if (tag === 'BR') return BREAK;
  if (SKIP.test(tag)) return '';
  if (tag === 'CODE' && !n.textContent?.includes('`')) return wrap(n.textContent ?? '', '`');
  const body = [...n.childNodes].map(md).join('');
  if (BLOCK.test(tag)) return BREAK + body + BREAK;
  if (tag === 'B' || tag === 'STRONG') return wrap(body, '**');
  if (tag === 'I' || tag === 'EM') return wrap(body, '*');
  const href = n.getAttribute('href');
  if (tag === 'A' && body.trim() && safeHref(href)) {
    const url = href
      .trim()
      .replace(/[\s()]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return `[${body}](${url})`;
  }
  return body;
}

/** The element as `after`: each block's whitespace run together, empty
 *  blocks dropped. */
export function toMarkdown(el: Element): string {
  return [...el.childNodes]
    .map(md)
    .join('')
    .split(BREAK)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function spanNode(s: MdSpan): Node {
  let node: Node = document.createTextNode(s.text);
  for (const [on, tag] of [
    [s.code, 'code'],
    [s.i, 'i'],
    [s.b, 'b'],
  ] as const) {
    if (!on) continue;
    const e = document.createElement(tag);
    e.append(node);
    node = e;
  }
  if (safeHref(s.href ?? null)) {
    const a = document.createElement('a');
    a.setAttribute('href', s.href as string);
    a.append(node);
    node = a;
  }
  return node;
}

/** Show `after` in the element: its marks, and a line break between blocks.
 *  Built node by node, so nothing in it is ever read as markup. */
export function renderMarkdown(el: HTMLElement, after: string): void {
  el.replaceChildren();
  after.split(/\n\s*\n/).forEach((block, i) => {
    if (i > 0) el.append(document.createElement('br'));
    el.append(...mdSpans(block.trim()).map(spanNode));
  });
}
