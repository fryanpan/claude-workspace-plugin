/**
 * What the judge is told about the five fleet rules, and how its answer is
 * read. The prompt text is the only half testable without a live call, so
 * each rule's exceptions — the asks that must still reach the reader — are
 * asserted present by name.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewJudgePrompt, parseReviewJudgeResponse } from './review-judge-prompt.ts';
import { REVIEW_REFUSAL_KINDS, REVIEW_REFUSAL_RULES } from './review-refusal.ts';

const ITEM = { headline: 'Spend about $9 re-running the Harborlight eval?' };

describe('the judge is taught the five rules', () => {
  const { system, user } = buildReviewJudgePrompt('Criteria text.', ITEM);

  it('names every rule, before the criteria', () => {
    for (const kind of REVIEW_REFUSAL_KINDS) {
      const at = system.indexOf(`- "${kind}":`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(system.indexOf('Criteria:'));
    }
    expect(system).toContain('"refuse"');
  });

  it('keeps every ask a rule does not answer on the reader’s side', () => {
    // The controls: over $50, push-only, D-class, risk surface, taste, a
    // device only the reader has, and a permission denial.
    for (const exception of [
      'the spend is over $50',
      'the repo ships push-only',
      'a breaking change on the default branch',
      'a public deploy of a breaking change',
      'an external send',
      'an irreversible delete',
      'a force-push',
      'a named risk surface',
      'a product or taste judgement only the reader can make',
      'deletes or loses data',
      'a device, account or place only the reader has',
      'NOT refused when the options offer a real trade-off',
      'refused permission',
      'When you are unsure whether a rule answers the ask, do not refuse it',
    ]) {
      expect(system).toContain(exception);
    }
  });

  it('says nothing about an appeal on a first filing', () => {
    expect(system).not.toContain('You refused an earlier version');
    expect(user).not.toContain('refuse');
  });

  it('tells a revision which rule refused it, so its reason is heard', () => {
    const appeal = buildReviewJudgePrompt('Criteria text.', { ...ITEM, priorRefusal: 'spend' });
    expect(appeal.system).toContain(
      'You refused an earlier version of this item under the "spend" rule',
    );
  });

  it('leaves the rules out for a check the agent was refused permission to run', () => {
    const refused = buildReviewJudgePrompt('Criteria text.', {
      ...ITEM,
      ownerCheck: true,
      refusedCheck: true,
    });
    expect(refused.system).not.toContain('- "self-check":');
  });
});

describe('the judge’s refusal is read strictly', () => {
  it('reads a known rule on a hold', () => {
    expect(parseReviewJudgeResponse('{"ok": false, "reason": "", "refuse": "ship"}')?.refuse).toBe(
      'ship',
    );
  });

  it('drops an unknown rule and a refusal on a pass', () => {
    expect(
      parseReviewJudgeResponse('{"ok": false, "reason": "x", "refuse": "taste"}')?.refuse,
    ).toBeUndefined();
    expect(
      parseReviewJudgeResponse('{"ok": true, "reason": "x", "refuse": "spend"}')?.refuse,
    ).toBeUndefined();
  });
});

describe('what a refused filer is told', () => {
  it('is one sentence per rule, and never routes around a denial', () => {
    for (const kind of REVIEW_REFUSAL_KINDS) {
      const rule = REVIEW_REFUSAL_RULES[kind];
      expect(rule.split(/[.!?](\s|$)/).filter((s) => s.trim() !== '').length).toBe(1);
      expect(rule).not.toMatch(/another|separate|second|work\s?around|session/i);
    }
  });
});
