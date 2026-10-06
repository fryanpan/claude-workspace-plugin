/**
 * Home's review section grouped by the week's goals: the plan lead's Top 10
 * first, in rank order, then one section per goal in the plan's goal order
 * with urgent first, the untagged items under one count line, and
 * not-this-week and drop folded shut. With no tags at all, Home is exactly
 * the review bar it was.
 *
 * Fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { TOP_COUNT, goalView } from '../src/landing-goals.ts';
import { type LandingReview, renderReviewBar } from '../src/landing-review.ts';

const NOW = Date.UTC(2026, 9, 5, 16, 0);
const GOALS = [
  { id: 'g-tide', title: 'Tide tables out (Tue)' },
  { id: 'g-ferry', title: 'Ferry wrap-up (Fri)' },
];

type Item = LandingReview['items'][number];
const item = (n: number, ws: string, extra: Partial<Item> = {}): Item => ({
  workspaceId: ws,
  project: ws === 'w-harbor' ? 'Harborlight' : ws === 'w-river' ? 'Riverbend' : 'Saltmarsh',
  key: `${ws}:task-review:t-${n}:r-${n}`,
  ask: `Ask ${n}`,
  title: `Task ${n}`,
  since: NOW - n * 3_600_000,
  ...extra,
});

/** In queue order, as the server hands them over: ranked first. */
const ITEMS: Item[] = [
  item(1, 'w-river', { leadRank: 1, goalTag: 'g-ferry' }),
  item(2, 'w-harbor', { leadRank: 2, goalTag: 'urgent' }),
  item(3, 'w-salt', { leadRank: 3, goalTag: 'not-this-week' }),
  item(4, 'w-harbor', { goalTag: 'g-tide' }),
  item(5, 'w-river'),
  item(6, 'w-salt', { goalTag: 'drop' }),
  item(7, 'w-harbor', { goalTag: 'g-ferry' }),
  item(8, 'w-river', { goalTag: 'g-gone' }),
];

const review = (items: Item[], goals = GOALS): LandingReview => ({
  items,
  rankOf: new Map(),
  summaryOf: () => undefined,
  goals,
});

/** Each rendered section: its heading, whether it is open, and its asks. */
function sections(html: string) {
  return [
    ...html.matchAll(
      /<details class="goal-sec[^"]*"( open)?><summary>(.*?)<\/summary>(.*?)<\/details>/g,
    ),
  ].map((m) => ({
    heading: (m[2] ?? '').replace(/<[^>]+>/g, '').trim(),
    open: m[1] !== undefined,
    asks: [...(m[3] ?? '').matchAll(/class="goal-row-title">([^<]*)</g)].map((a) => a[1]),
  }));
}

function topAsks(html: string): string[] {
  const top = html.match(/<ol class="goal-top">(.*?)<\/ol>/)?.[1] ?? '';
  return [...top.matchAll(/class="goal-row-title">([^<]*)</g)].map((a) => a[1] ?? '');
}

describe('Home grouped by goal', () => {
  it('shows the Top 10 first in rank order, then goals in plan order with urgent first', () => {
    const html = renderReviewBar(review(ITEMS), NOW);
    // Ranked and not folded away: item 3 is ranked but not this week.
    expect(topAsks(html)).toEqual(['Ask 1', 'Ask 2']);
    expect(sections(html)).toEqual([
      { heading: 'Urgent 1', open: true, asks: ['Ask 2'] },
      { heading: 'Tide tables out (Tue) 1', open: true, asks: ['Ask 4'] },
      { heading: 'Ferry wrap-up (Fri) 2', open: true, asks: ['Ask 1', 'Ask 7'] },
      // A tag naming a goal the plan no longer has counts as untagged.
      { heading: '2 new since the last pass', open: true, asks: ['Ask 5', 'Ask 8'] },
      { heading: 'Not this week 1', open: false, asks: ['Ask 3'] },
      { heading: 'Propose dropping 1', open: false, asks: ['Ask 6'] },
    ]);
  });

  it('follows the plan’s goal order, not the order tags were set', () => {
    const swapped = [GOALS[1], GOALS[0]] as typeof GOALS;
    const headings = sections(renderReviewBar(review(ITEMS, swapped), NOW)).map((s) => s.heading);
    expect(headings.slice(1, 3)).toEqual(['Ferry wrap-up (Fri) 2', 'Tide tables out (Tue) 1']);
  });

  it('keeps the Top 10 to ten', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      item(i + 1, 'w-harbor', { leadRank: i + 1, goalTag: 'g-tide' }),
    );
    const top = goalView(many, GOALS).top;
    expect(top).toHaveLength(TOP_COUNT);
    expect(top.map((i) => i.ask)).toEqual(many.slice(0, 10).map((i) => i.ask));
  });

  it('opens each ask in the review walk at that ask', () => {
    const html = renderReviewBar(review(ITEMS), NOW);
    expect(html).toContain(`href="/review?item=${encodeURIComponent(ITEMS[0]?.key ?? '')}"`);
  });

  it('with no tags at all, is exactly the review bar it was', () => {
    const untagged = ITEMS.map(({ goalTag: _goal, leadRank: _rank, ...rest }) => rest);
    const ranked = ITEMS.map(({ goalTag: _goal, ...rest }) => rest);
    const before = renderReviewBar({ items: untagged, rankOf: new Map(), summaryOf: () => '' });
    expect(before).toContain('class="qgrp"');
    expect(renderReviewBar(review(untagged), NOW)).toBe(before);
    // Ranks alone change the order, never the look.
    expect(renderReviewBar(review(ranked), NOW)).toBe(before);
    // Nor do tags that all name goals the plan no longer has.
    const stale = untagged.map((i) => ({ ...i, goalTag: 'g-gone' }));
    expect(renderReviewBar(review(stale), NOW)).toBe(before);
  });
});
