import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment, parseMarkdownBlocks, serializeKeepingSource } from '../src/prose.ts';

/**
 * A map or chart in a site's markdown is a placeholder block a template
 * engine reads line by line: `{{# map }}` … `{{/ map }}`, or `:::name{…}` …
 * `:::`. Editing one line inside it used to join every line onto one on the
 * next write-back, which the engine no longer recognizes.
 */
function docOf(markdown: string): Y.XmlFragment {
  const fragment = getProseFragment(new Y.Doc());
  fragment.push(parseMarkdownBlocks(markdown));
  return fragment;
}

/** Replace `from` with `to` inside the live doc's text, as a keystroke would. */
function editText(fragment: Y.XmlFragment, from: string, to: string): void {
  const walk = (node: Y.XmlElement | Y.XmlFragment): boolean => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        const at = child.toString().indexOf(from);
        if (at >= 0) {
          child.delete(at, from.length);
          child.insert(at, to);
          return true;
        }
      } else if (child instanceof Y.XmlElement && walk(child)) return true;
    }
    return false;
  };
  if (!walk(fragment)) throw new Error(`no text ${from}`);
}

const SOURCE = `# Riverbend walks

Intro paragraph.

{{# map }}
center: 37.77,-122.42
zoom: 13
{{/ map }}

:::sfworks{kind="chart" id="harborlight"}
series: visits
range: 2026
:::

Closing words.
`;

describe('placeholder blocks keep their line breaks', () => {
  it('keeps every line of a {{# }} block when a line inside it is edited', () => {
    const live = docOf(SOURCE);
    editText(live, 'zoom: 13', 'zoom: 14');
    expect(serializeKeepingSource(live, SOURCE)).toBe(SOURCE.replace('zoom: 13', 'zoom: 14'));
  });

  it('keeps every line of a ::: block when a line inside it is edited', () => {
    const live = docOf(SOURCE);
    editText(live, 'range: 2026', 'range: 2025');
    expect(serializeKeepingSource(live, SOURCE)).toBe(SOURCE.replace('range: 2026', 'range: 2025'));
  });

  it('still joins an ordinary soft-wrapped paragraph when it is edited', () => {
    const source = 'Saltmarsh is a\nsoft-wrapped paragraph.\n';
    const live = docOf(source);
    editText(live, 'soft-wrapped', 'wrapped');
    expect(serializeKeepingSource(live, source)).toBe('Saltmarsh is a wrapped paragraph.\n');
  });
});
