/**
 * "This week" as the front page draws it: the editor open when the week has
 * no goals, the nudge with its two answers, and every word escaped.
 */
import { describe, expect, it } from 'bun:test';
import { renderCoachSection } from '../src/coach/section.ts';

describe('renderCoachSection', () => {
  it('asks for the week’s goals, editor open, when there are none', () => {
    const html = renderCoachSection({ goals: null, nudge: null, lastPass: undefined });
    expect(html).toContain('Set up to 3 goals for this week');
    expect(html).toContain('<form class="coach-edit" data-coach-edit>');
    expect(html.match(/name="goal"/g)).toHaveLength(3);
    expect(html).not.toContain('data-act="cancel"');
    expect(html).toContain('Not checked yet');
  });

  it('lists the goals, folds the editor, and draws one nudge with both answers', () => {
    const html = renderCoachSection({
      goals: { week: '2026-10-05', goals: ['Ship <b>it</b>', 'Write'], setAt: 1 },
      nudge: {
        id: 'cn-aaaaaaaaaaaa',
        at: 2,
        day: '2026-10-07',
        goalIndex: 0,
        goal: 'Ship <b>it</b>',
        drift: 'Fonts <script>x</script>',
        question: 'Still shipping it?',
        state: 'open',
      },
      lastPass: { at: 3, outcome: 'nudged', lines: 4 },
    });
    expect(html).toContain('<li>Ship &lt;b&gt;it&lt;/b&gt;</li><li>Write</li>');
    expect(html).toContain('data-coach-edit hidden');
    expect(html).toContain('data-nudge="cn-aaaaaaaaaaaa"');
    expect(html).toContain('Fonts &lt;script&gt;x&lt;/script&gt; · goal 1');
    expect(html).not.toContain('<script>');
    expect(html).toContain('data-answer="back-to-it"');
    expect(html).toContain('data-answer="plans-changed"');
  });
});
