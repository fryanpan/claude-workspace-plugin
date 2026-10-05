/**
 * An edited element as the markdown an edit's `after` carries, and back.
 *
 * The format is `core/src/page-edits-text.ts`: blocks joined by a blank
 * line. A line break the reviewer typed, or a block the browser made inside
 * the element, starts a new block.
 */

/** Where one block ends and the next starts, while the text is built. */
const BREAK = ' ';
/** Elements that are a block of their own when they turn up inside the one
 *  being edited — the browser makes a `div` when Enter splits a line. */
const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|PRE|H[1-6])$/;
/** Elements whose content is not words on the page. */
const SKIP = /^(SVG|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|IMG|PICTURE|VIDEO|AUDIO|CANVAS)$/;

function md(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
  if (!(n instanceof Element)) return '';
  const tag = n.tagName.toUpperCase();
  if (tag === 'BR') return BREAK;
  if (SKIP.test(tag)) return '';
  const body = [...n.childNodes].map(md).join('');
  return BLOCK.test(tag) ? BREAK + body + BREAK : body;
}

/** The element's words as `after`: each block's whitespace run together,
 *  empty blocks dropped. */
export function toMarkdown(el: Element): string {
  return [...el.childNodes]
    .map(md)
    .join('')
    .split(BREAK)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Show `after` in the element: its blocks, a line break between each. */
export function renderMarkdown(el: HTMLElement, after: string): void {
  el.replaceChildren();
  after.split(/\n\s*\n/).forEach((block, i) => {
    if (i > 0) el.append(document.createElement('br'));
    el.append(block);
  });
}
