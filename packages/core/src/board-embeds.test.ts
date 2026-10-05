import { describe, expect, it } from 'vitest';
import {
  clampEmbedHeight,
  embedUrl,
  parseBoardEmbeds,
  parseEmbedDirective,
} from './board-embeds.ts';

const EMBEDS = { sfworks: { appDocId: 'd-app1', pathTemplate: '{mount}/embed/bike/{block}/' } };

describe('parseEmbedDirective', () => {
  it('reads the block of a whole-paragraph directive', () => {
    expect(parseEmbedDirective('::sfworks{block="goal-chart"}')).toEqual({
      name: 'sfworks',
      block: 'goal-chart',
    });
  });
  it('refuses a block outside the safe alphabet, and any prose around it', () => {
    expect(parseEmbedDirective('::sfworks{block="../x"}')).toBeNull();
    expect(parseEmbedDirective('::sfworks{block="A"}')).toBeNull();
    expect(parseEmbedDirective('see ::sfworks{block="a"}')).toBeNull();
    expect(parseEmbedDirective('::sfworks{src="a"}')).toBeNull();
  });
});

describe('embedUrl', () => {
  it('builds the mapped same-origin path from block alone', () => {
    expect(embedUrl(EMBEDS, 'w-1', 'sfworks', 'goal-chart')).toBe(
      '/workspaces/w-1/apps/d-app1/embed/bike/goal-chart/?cw-frame=1&cw-embed=1',
    );
  });
  it('answers null with no mapping or a bad block', () => {
    expect(embedUrl(null, 'w-1', 'sfworks', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'other', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'toString', 'a')).toBeNull();
    expect(embedUrl(EMBEDS, 'w-1', 'sfworks', 'a/b')).toBeNull();
  });
});

describe('parseBoardEmbeds', () => {
  it('accepts the sfworks mapping', () => {
    expect(parseBoardEmbeds(EMBEDS)).toEqual({ ok: true, embeds: EMBEDS });
  });
  it('refuses a template that leaves the mount or climbs out of it', () => {
    for (const pathTemplate of [
      'https://evil/{block}',
      '/x/{block}',
      '{mount}/../{block}',
      '{mount}?q={block}',
    ]) {
      expect(parseBoardEmbeds({ sfworks: { appDocId: 'd-app1', pathTemplate } }).ok).toBe(false);
    }
    expect(parseBoardEmbeds({ sfworks: { appDocId: '../x', pathTemplate: '{mount}/' } }).ok).toBe(
      false,
    );
    expect(parseBoardEmbeds({ Bad: EMBEDS.sfworks }).ok).toBe(false);
  });
});

it('clamps a height into range', () => {
  expect(clampEmbedHeight(5)).toBe(80);
  expect(clampEmbedHeight(99999)).toBe(2000);
  expect(clampEmbedHeight(321.4)).toBe(321);
});
