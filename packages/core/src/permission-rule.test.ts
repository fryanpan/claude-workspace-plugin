import { describe, expect, it } from 'vitest';
import { GRANT_LIMITS, permissionRuleProblem, readAllowRules } from './permission-rule.ts';
import { checkReviewPayload, readReviewPayload } from './review-item.ts';

/** A well-formed grant card, which each case below spoils in one way. */
function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_type: 'grant',
    headline: 'Allow the Harborlight release commands until this task closes',
    detail: 'The release step force-pushes the rebuilt branch and tags it.',
    allowRules: ['Bash(git push --force-with-lease:*)', 'Bash(git tag:*)'],
    ...over,
  };
}

describe('which lines a grant card may carry', () => {
  it('admits a prefix rule, a path rule and a domain rule', () => {
    expect(permissionRuleProblem('Bash(git push --force-with-lease:*)')).toBeUndefined();
    expect(permissionRuleProblem('Edit(packages/server/src/**)')).toBeUndefined();
    expect(permissionRuleProblem('WebFetch(domain:riverbend.example)')).toBeUndefined();
    expect(permissionRuleProblem('mcp__saltmarsh__read_page(page:*)')).toBeUndefined();
  });

  it('refuses bare Bash and every other bare tool name', () => {
    expect(permissionRuleProblem('Bash')).toMatch(/bare tool name/);
    expect(permissionRuleProblem('WebFetch')).toMatch(/bare tool name/);
    expect(permissionRuleProblem('mcp__saltmarsh__read_page')).toMatch(/bare tool name/);
  });

  it('refuses a specifier that covers the whole tool', () => {
    for (const whole of ['Bash(*)', 'Bash(:*)', 'Bash(*:*)', 'Read(~/**)', 'Read(//**)']) {
      expect(permissionRuleProblem(whole)).toMatch(/whole tool/);
    }
    expect(permissionRuleProblem('WebFetch(domain:*)')).toMatch(/whole tool/);
    expect(permissionRuleProblem('Bash()')).toMatch(/bare tool name/);
  });

  it('refuses a line break, padding and an over-long line', () => {
    expect(permissionRuleProblem('Bash(git push:*)\nBash')).toMatch(/one line/);
    expect(permissionRuleProblem(' Bash(git push:*)')).toMatch(/whitespace/);
    const long = `Bash(${'a'.repeat(GRANT_LIMITS.ruleMaxChars)}:*)`;
    expect(permissionRuleProblem(long)).toMatch(/characters/);
  });

  it('reads back only admissible lines, once each', () => {
    expect(readAllowRules(['Bash(git tag:*)', 'Bash', 'Bash(git tag:*)', 7])).toEqual([
      'Bash(git tag:*)',
    ]);
    expect(readAllowRules(['Bash'])).toBeUndefined();
    expect(readAllowRules('Bash(git tag:*)')).toBeUndefined();
  });
});

describe('a grant card at the filing gate', () => {
  it('admits a card listing each line', () => {
    const check = checkReviewPayload(card());
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('stores the lines and forces owner-only whatever the caller said', () => {
    const read = readReviewPayload(card({ ownerOnly: false }));
    expect(read?.shape).toBe('grant');
    expect(read?.allowRules).toEqual(['Bash(git push --force-with-lease:*)', 'Bash(git tag:*)']);
    expect(read?.ownerOnly).toBe(true);
  });

  it('refuses a card with no lines, and one carrying bare Bash', () => {
    expect(checkReviewPayload(card({ allowRules: [] })).ok).toBe(false);
    const bare = checkReviewPayload(card({ allowRules: ['Bash(git tag:*)', 'Bash'] }));
    expect(bare.ok).toBe(false);
    expect(bare.errors.join(' ')).toMatch(/allowRules\[1\]/);
  });

  it('refuses any attempt to name deny or ask rules', () => {
    for (const key of ['deny', 'ask', 'permissions']) {
      const check = checkReviewPayload(card({ [key]: ['Bash(git tag:*)'] }));
      expect(check.ok).toBe(false);
      expect(check.errors.join(' ')).toMatch(/never changes deny or ask/);
    }
    // Control: the same card without the key is admitted.
    expect(checkReviewPayload(card()).ok).toBe(true);
  });

  it('refuses options, and refuses allowRules on any other shape', () => {
    const opts = checkReviewPayload(
      card({
        options: [
          { id: 'a', label: 'Yes' },
          { id: 'b', label: 'No' },
        ],
      }),
    );
    expect(opts.ok).toBe(false);
    const onQuestion = checkReviewPayload(card({ review_type: 'question' }));
    expect(onQuestion.ok).toBe(false);
    expect(onQuestion.errors.join(' ')).toMatch(/belong to a 'grant' card/);
  });
});
