import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MATH_DISPLAY_LANGUAGE, mathDisplayTex, mathTextAt } from '../src/prose-math.ts';
import {
  detectLiteralMarkdown,
  findAndReplace,
  getProseFragment,
  inlineMarksToDelta,
  normalizeMarkdown,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
  serializeKeepingSource,
} from '../src/prose.ts';

/**
 * remark-math equations survive the round trip byte for byte AND parse to an
 * equation, not to prose.
 *
 * Both halves, for the reason `inline-mark-roundtrip.test.ts` gives: bytes
 * surviving is not the same as parsing correctly. `$a*b$ and $c*d$` was
 * ALREADY a fixed point before math was parsed, because the parser read
 * `*b$ and $c*` as an italic and the serializer wrote the asterisks back.
 *
 * The "remark-math reads" notes are measured with remark-parse 11 +
 * remark-math 6, not recalled.
 */

type Op = [string, Record<string, unknown> | undefined];
const M = { math: true };
const M2 = { math: { dollars: 2 } };

function parsedOps(md: string): Op[] {
  return inlineMarksToDelta(md).map((op) => [op.insert, op.attributes]);
}

/** Each top-level block as `name` or `name:language`, with its text. */
function blocksOf(md: string): Array<[string, string]> {
  const fragment = getProseFragment(new Y.Doc());
  fragment.push(parseMarkdownBlocks(md));
  return (fragment.toArray() as Y.XmlElement[]).map((el) => {
    const lang = el.getAttribute('language');
    return [lang ? `${el.nodeName}:${lang}` : el.nodeName, el.toArray().map(String).join('')];
  });
}

function docOf(markdown: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(markdown));
  return { doc, fragment };
}

describe('where a dollar opens math (remark-math, less the two declines)', () => {
  const read = (text: string): Array<string> => {
    const out: string[] = [];
    let i = 0;
    let lit = '';
    while (i < text.length) {
      const m = mathTextAt(text, i);
      if (m?.kind === 'math') {
        if (lit) out.push(lit);
        lit = '';
        out.push(`math${m.dollars}:${text.slice(i + m.dollars, m.end - m.dollars)}`);
        i = m.end;
      } else if (m) {
        lit += text.slice(i, m.end);
        i = m.end;
      } else {
        lit += text[i];
        i++;
      }
    }
    if (lit) out.push(lit);
    return out;
  };

  it.each<[string, string[]]>([
    // remark-math agrees on every one of these.
    ['$x_e$', ['math1:x_e']],
    ['$a*b$ and $c*d$', ['math1:a*b', ' and ', 'math1:c*d']],
    ['a$x$b', ['a', 'math1:x', 'b']],
    ['$$x$$ inline', ['math2:x', ' inline']],
    ['$x$$y$', ['math1:x$$y']],
    ['$$x$', ['$$x$']],
    ['\\$5 and $10', ['\\$5 and $10']],
    ['\\\\$x$', ['\\\\', 'math1:x']],
    ['$a\\$b$', ['math1:a\\', 'b$']],
    ['price $5.', ['price $5.']],
    ['$x$5 is not a price', ['$x$5 is not a price']],
  ])('%j', (text, expected) => {
    expect(read(text)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    // remark-math reads each of these as an equation; this parser declines,
    // so the text stays text and the bytes are the same either way.
    ['$5 and $10', ['$5 and $10']],
    ['$5k-$10k', ['$5k-$10k']],
    ['costs $5/$10 now', ['costs $5/$10 now']],
    ['$ x $', ['$ x $']],
    // remark-math: `a ` is math and `b$` text. Declining the first span must
    // not start a second at its closer, or `b` would be drawn as math here
    // and nowhere else.
    ['$a $b$', ['$a $b$']],
  ])('declines %j', (text, expected) => {
    expect(read(text)).toEqual(expected);
  });
});

const INLINE: Array<{ name: string; md: string; ops: Op[] }> = [
  {
    name: 'subscript',
    md: 'Energy $x_e$ here',
    ops: [
      ['Energy ', undefined],
      ['x_e', M],
      [' here', undefined],
    ],
  },
  {
    // The case that was a fixed point before the fix, with an italic inside.
    name: 'two equations holding asterisks',
    md: '$a*b$ and $c*d$',
    ops: [
      ['a*b', M],
      [' and ', undefined],
      ['c*d', M],
    ],
  },
  {
    name: 'backslashes and braces',
    md: 'ratio $\\frac{a}{b} = \\{x\\}$ done',
    ops: [
      ['ratio ', undefined],
      ['\\frac{a}{b} = \\{x\\}', M],
      [' done', undefined],
    ],
  },
  {
    name: 'double-dollar inline',
    md: 'see $$\\sum_i x_i$$ inline',
    ops: [
      ['see ', undefined],
      ['\\sum_i x_i', M2],
      [' inline', undefined],
    ],
  },
  {
    name: 'an italic around an equation holding an asterisk',
    md: '*a $b*c$ d*',
    ops: [
      ['a ', { italic: true }],
      ['b*c', { italic: true, math: true }],
      [' d', { italic: true }],
    ],
  },
  {
    name: 'bold equation',
    md: '**$x^*$ bold**',
    ops: [
      ['x^*', { bold: true, math: true }],
      [' bold', { bold: true }],
    ],
  },
  {
    name: 'math in backticks stays code',
    md: 'write `$x$` for math',
    ops: [
      ['write ', undefined],
      ['$x$', { code: true }],
      [' for math', undefined],
    ],
  },
  {
    name: 'prices stay text',
    md: 'It costs $5 and $10, or $5k-$10k.',
    ops: [['It costs $5 and $10, or $5k-$10k.', undefined]],
  },
  {
    name: 'snake_case beside an equation',
    md: 'field estimated_effort_h is $h_e$',
    ops: [
      ['field estimated_effort_h is ', undefined],
      ['h_e', M],
    ],
  },
];

describe('inline math round-trips byte-identical AND parses to an equation', () => {
  for (const { name, md, ops } of INLINE) {
    it(`${name}: fixed point`, () => {
      expect(normalizeMarkdown(`${md}\n`)).toBe(`${md}\n`);
    });
    it(`${name}: parsed shape`, () => {
      expect(parsedOps(md)).toEqual(ops);
    });
  }
});

const BLOCKS: Array<{ name: string; md: string; blocks: Array<[string, string]> }> = [
  {
    // Measured on main: became `$$ \frac{a}{b} = x_e $$` on one line.
    name: 'display equation on its own lines',
    md: '$$\n\\frac{a}{b} = x_e\n$$\n',
    blocks: [[`codeBlock:${MATH_DISPLAY_LANGUAGE}`, '$$\n\\frac{a}{b} = x_e\n$$']],
  },
  {
    // Measured on main: split into two paragraphs at the blank line.
    name: 'display equation with a blank line inside',
    md: 'Before.\n\n$$\n\\begin{aligned}\na &= b_1 * c\n\n\\\\ d &= e\n\\end{aligned}\n$$\n\nAfter.\n',
    blocks: [
      ['paragraph', 'Before.'],
      [
        `codeBlock:${MATH_DISPLAY_LANGUAGE}`,
        '$$\n\\begin{aligned}\na &= b_1 * c\n\n\\\\ d &= e\n\\end{aligned}\n$$',
      ],
      ['paragraph', 'After.'],
    ],
  },
  {
    name: 'a longer fence, a meta word and a heading-shaped line inside',
    md: '$$$ eq\n# not a heading\n$$\n$$$\n',
    blocks: [[`codeBlock:${MATH_DISPLAY_LANGUAGE}`, '$$$ eq\n# not a heading\n$$\n$$$']],
  },
  {
    name: 'display equation inside a list item',
    md: '- first\n\n  $$\n  x_1 * y_2\n\n  z\n  $$\n- second\n',
    blocks: [['bulletList', '']],
  },
  {
    name: 'display equation inside a blockquote',
    md: '> $$\n> x_1\n>\n> y\n> $$\n',
    blocks: [['blockquote', '']],
  },
  {
    // remark-math runs an unclosed fence to the end of the document.
    name: 'an unclosed fence stays text',
    md: 'Costs $$5 total.\n\nNext paragraph.\n',
    blocks: [
      ['paragraph', 'Costs $$5 total.'],
      ['paragraph', 'Next paragraph.'],
    ],
  },
];

describe('display math round-trips byte-identical AND parses to one block', () => {
  for (const { name, md, blocks } of BLOCKS) {
    it(`${name}: fixed point`, () => {
      expect(normalizeMarkdown(md)).toBe(md);
    });
    it(`${name}: parsed shape`, () => {
      const got = blocksOf(md);
      expect(got.map(([n]) => n)).toEqual(blocks.map(([n]) => n));
      for (let k = 0; k < blocks.length; k++) {
        if (blocks[k]![1]) expect(got[k]![1]).toBe(blocks[k]![1]);
      }
    });
  }

  it('reads a list item’s equation as a block of its own, indent stripped', () => {
    const { fragment } = docOf('- first\n\n  $$\n  x_1 * y_2\n\n  z\n  $$\n- second\n');
    const item = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const eq = item.get(1) as Y.XmlElement;
    expect(eq.nodeName).toBe('codeBlock');
    expect(eq.getAttribute('language')).toBe(MATH_DISPLAY_LANGUAGE);
    expect(eq.get(0)!.toString()).toBe('$$\nx_1 * y_2\n\nz\n$$');
  });

  it('reads a quote that is one equation as that block, blank line included', () => {
    const { fragment } = docOf('> $$\n> x_1\n>\n> y\n> $$\n');
    const eq = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    expect(eq.getAttribute('language')).toBe(MATH_DISPLAY_LANGUAGE);
    expect(eq.get(0)!.toString()).toBe('$$\nx_1\n\ny\n$$');
  });

  it('reads an equation sharing a quote with prose as an inline equation', () => {
    const md = '> Where:\n> $$\n> x_1\n> $$\n';
    expect(normalizeMarkdown(md)).toBe(md);
    const para = (docOf(md).fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    expect((para.get(0) as Y.XmlText).toDelta()).toEqual([
      { insert: 'Where:\n' },
      { insert: '\nx_1\n', attributes: M2 },
    ]);
  });

  it('interrupts a paragraph, as a code fence does', () => {
    expect(blocksOf('para\n$$\nx\n$$\n').map(([n]) => n)).toEqual([
      'paragraph',
      `codeBlock:${MATH_DISPLAY_LANGUAGE}`,
    ]);
  });

  it('gives the renderer the TeX between the fences', () => {
    expect(mathDisplayTex('$$ eq\na\n\nb\n$$')).toBe('a\n\nb');
  });
});

describe('the file comes back byte for byte through Yjs and an edit elsewhere', () => {
  // Soft-wrapped prose and a four-space list on purpose: the plain
  // serializer rewrites both, so only the write-back's source-keeping can
  // return them, and only if every equation block still matches its source.
  const SOURCE = [
    '# Notes',
    '',
    'Inline $x_e$, $\\frac{a}{b}$ and $a*b$ and $c*d$,',
    'wrapped onto a second line, and it costs $5 and $10.',
    '',
    '$$',
    '\\frac{a}{b} = x_e',
    '$$',
    '',
    '$$',
    'a &= b',
    '',
    'c &= d',
    '$$',
    '',
    '* item with $y^2$',
    '    * deep $\\{z\\}$',
    '',
    '> quoted $q_1$',
    '',
    'Last paragraph.',
    '',
  ].join('\n');

  it('returns the source unchanged when nothing was edited', () => {
    const { fragment } = docOf(SOURCE);
    expect(serializeKeepingSource(fragment, SOURCE)).toBe(SOURCE);
  });

  it('keeps every equation’s bytes when another paragraph is edited, after a Yjs sync', () => {
    const { doc } = docOf(SOURCE);
    // Through an encoded update: what the server persists and a browser reads.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const frag = getProseFragment(peer);
    const last = frag.get(frag.length - 1) as Y.XmlElement;
    (last.get(0) as Y.XmlText).insert(0, 'Edited. ');
    expect(serializeKeepingSource(frag, SOURCE)).toBe(
      SOURCE.replace('Last paragraph.', 'Edited. Last paragraph.'),
    );
  });

  it('writes an editor-shaped math mark back with its own dollar count', () => {
    const { fragment } = docOf('x\n');
    const t = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    // y-prosemirror writes a mark's attrs object, never `true`.
    t.insert(1, 'y_1', { math: { dollars: 1 } });
    t.insert(4, 'z', { math: { dollars: 2 } });
    expect(serializeFragmentToMarkdown(fragment)).toBe('x$y_1$$$z$$\n');
  });
});

describe('the literal-markdown check reads TeX as TeX', () => {
  it('raises nothing for asterisks and hashes inside an equation', () => {
    const { fragment } = docOf('$a**b**c$ and $\\#x$\n\n$$\n**not bold**\n$$\n');
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('still raises the same asterisks outside one (positive control)', () => {
    const fragment = getProseFragment(new Y.Doc());
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    fragment.push([p]);
    t.insert(0, 'a **b** c');
    expect(detectLiteralMarkdown(fragment)).not.toBeNull();
  });
});

describe('find_and_replace leaves equations alone', () => {
  const SOURCE = 'Energy $x_e$ here and $a*b$.\n\n$$\n\\frac{a}{b}\n$$\n';

  it('edits the prose beside an equation without touching it', () => {
    const { doc, fragment } = docOf(SOURCE);
    expect(findAndReplace(doc, { find: 'here', replace: 'there' }).ok).toBe(true);
    expect(serializeKeepingSource(fragment, SOURCE)).toBe(SOURCE.replace('here', 'there'));
  });

  it('matches the TeX as it reads, and the replacement stays an equation', () => {
    const { doc, fragment } = docOf(SOURCE);
    expect(findAndReplace(doc, { find: 'x_e', replace: 'y_e' }).ok).toBe(true);
    expect(serializeFragmentToMarkdown(fragment)).toBe(SOURCE.replace('$x_e$', '$y_e$'));
  });

  it('turns dollar syntax in a parsed replacement into an equation, and a price into text', () => {
    const { doc, fragment } = docOf(SOURCE);
    findAndReplace(doc, { find: 'here', replace: '$z_1$ for $5 and $10', parseInlineMarks: true });
    const t = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(t.toDelta()).toContainEqual({ insert: 'z_1', attributes: M });
    expect(serializeFragmentToMarkdown(fragment)).toBe(
      SOURCE.replace('here', '$z_1$ for $5 and $10'),
    );
  });
});
