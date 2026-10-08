/** The wording of the stale-ask wake (`review-stale-line.ts`). */
import { describe, expect, it } from 'vitest';
import { reviewItemStaleLine } from '../src/review-stale-line.ts';

const FRAME = {
  docId: 'task:t-riverbend',
  threadId: 'th-1',
  commentId: 'c-ask',
  headline: 'Keep the Riverbend button?',
  title: 'Riverbend mock round',
  rule: 'settled',
  withdraw:
    'withdraw_review_item(docId="task:t-riverbend", threadId="th-1", commentId="c-ask", reason="your reply settled it")',
};

describe('reviewItemStaleLine', () => {
  it('names the item, why it left Home, and the exact call that retires it', () => {
    const line = reviewItemStaleLine(FRAME);
    expect(line).toContain('"Keep the Riverbend button?"');
    expect(line).toContain('your own later reply on its thread settled it');
    expect(line).toContain(FRAME.withdraw);
    expect(line).toContain('file a new item if the question still stands');
  });

  it('says the subject is gone for an orphaned ask', () => {
    expect(reviewItemStaleLine({ ...FRAME, rule: 'orphaned' })).toContain(
      'what it was about is gone from the page',
    );
  });
});
