/**
 * The card that asks to add allow lines to the owner's settings: it lists
 * every line exactly, answers only by Approve or Decline, and offers no
 * composer. The composer's absence is checked against a control — an
 * ordinary question drawn by the same walkthrough, which has one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewItem,
  type ReviewQueue,
  type ReviewThreadItem,
  reviewGrantRequest,
  reviewItemBadge,
  reviewQueue,
} from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  type WalkthroughView,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';
import { WS } from './support/board-drive.ts';

const NOW = 1_700_000_000_000;
const RULES = ['Bash(git push --force-with-lease:*)', 'Bash(git tag:*)'];

function grantRow(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  return {
    kind: 'task-review',
    band: 'declared',
    review: {
      shape: 'grant',
      headline: 'Allow the release commands until this task closes',
      detail: 'The rebuild force-pushes the Harborlight branch and moves its tag.',
      ownerOnly: true,
      allowRules: RULES,
    },
    taskId: 'tk-1',
    reviewItemId: 'r-1',
    title: 'Rebuild the Harborlight release branch',
    ask: 'Allow the release commands until this task closes',
    askedBy: 'Riverbend Bot',
    since: NOW - 60_000,
    direct: true,
    askedAt: NOW - 60_000,
    ...over,
  } as unknown as ReviewThreadItem;
}

function questionRow(): ReviewThreadItem {
  return grantRow({
    review: { shape: 'review', headline: 'Green or blue?', detail: 'Which do we keep?' },
  } as Partial<ReviewThreadItem>);
}

function walk(over: Partial<WalkthroughHandlers> = {}): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(async () => true),
    onGrant: vi.fn(async () => true),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

let root: HTMLElement;
let dispose: (() => void) | null = null;

function mountWalk(
  queue: ReviewQueue,
  handlers: WalkthroughHandlers,
  patch: Partial<WalkthroughView> = {},
): void {
  dispose?.();
  walkthroughData.value = {
    queue,
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    handlers,
    secretsGate: 'open',
    ...patch,
  };
  dispose = mountWalkthroughIsland(root);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const buttonNamed = (name: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === name,
  );

beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/home`);
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('the model', () => {
  it('badges the item Permissions and posts to the grant door with the lines shown', () => {
    const [item] = reviewQueue([], [grantRow()], NOW).items as ReviewItem[];
    expect(reviewItemBadge(item as ReviewItem)).toEqual({ label: 'Permissions', tone: 'secret' });
    const req = reviewGrantRequest(item as ReviewItem, 'approve');
    expect(req?.path).toContain('/review-items/r-1/grant');
    expect(req?.body).toEqual({ decision: 'approve', allowRules: RULES });
  });

  it('builds no grant request for any other shape', () => {
    const [item] = reviewQueue([], [questionRow()], NOW).items as ReviewItem[];
    expect(reviewGrantRequest(item as ReviewItem, 'approve')).toBeNull();
  });
});

describe('the card', () => {
  it('lists every line exactly, and has no composer', async () => {
    mountWalk(reviewQueue([], [grantRow()], NOW), walk());
    await tick();
    const lines = Array.from(root.querySelectorAll('.board-grant-rule')).map((c) => c.textContent);
    expect(lines).toEqual(RULES);
    expect(root.querySelector('textarea')).toBeNull();
    // Control: the same walkthrough over an ordinary question draws a box.
    mountWalk(reviewQueue([], [questionRow()], NOW), walk());
    await tick();
    expect(root.querySelector('textarea')).not.toBeNull();
  });

  it('Approve and Decline each send their decision', async () => {
    const onGrant = vi.fn(async () => true);
    mountWalk(reviewQueue([], [grantRow()], NOW), walk({ onGrant }));
    await tick();
    buttonNamed('Approve')?.click();
    await tick();
    expect(onGrant).toHaveBeenCalledWith(expect.anything(), 'approve');
    buttonNamed('Decline')?.click();
    await tick();
    expect(onGrant).toHaveBeenCalledWith(expect.anything(), 'decline');
  });

  it('a member sees the lines and no buttons', async () => {
    mountWalk(reviewQueue([], [grantRow()], NOW), walk(), { secretsGate: 'not-owner' });
    await tick();
    expect(root.querySelectorAll('.board-grant-rule')).toHaveLength(RULES.length);
    expect(buttonNamed('Approve')).toBeUndefined();
    expect(root.textContent).toContain('Only the Owner can answer this.');
  });

  it('wraps a long line inside its box rather than widening the card', async () => {
    setViewport(IPAD);
    const sheets = installSheets('board.css', 'styles.css');
    try {
      mountWalk(reviewQueue([], [grantRow()], NOW), walk());
      await tick();
      const rule = root.querySelector<HTMLElement>('.board-grant-rule');
      const list = root.querySelector<HTMLElement>('.board-grant-rules');
      if (!rule || !list) throw new Error('the grant card did not render');
      expect(styleOf(rule).overflowWrap).toBe('anywhere');
      expect(styleOf(list).paddingLeft).toBe('0px');
      // Positive control on the harness: a property the shared rule sets.
      expect(styleOf(list).flexDirection).toBe('column');
    } finally {
      sheets();
    }
  });
});
