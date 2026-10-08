/**
 * The asks a fleet rule already answers, and the one sentence that names
 * each rule.
 *
 * Measured over one week of agent-filed asks: 66 of 206 (32%) asked the
 * reader something a standing fleet rule had already decided — a spend well
 * under the approval line, "open the PR now?" on a repo whose ship method is
 * the consent, a naming or test-strategy pick. Holding such an item for its
 * wording is the wrong remedy: a better-worded ask is still an ask nobody
 * needed. So the gate REFUSES these kinds, and a refusal is not a hold —
 * the two-hold cap and the one-hour release do not admit it.
 *
 * The rules live in the team-lead-fleet plugin, which the server cannot read
 * at runtime, so their substance is copied into the judge's prompt here. Each
 * entry names the rule it copies; when that rule changes, this file changes.
 *
 * Pure and in core beside the prompt, for the reason the prompt is: what the
 * judge is told and what the filer is told are asserted without a key.
 */

/** The five rules. The order is the order the judge is told them in. */
export const REVIEW_REFUSAL_KINDS = [
  'spend',
  'ship',
  'reversible',
  'self-check',
  'requested',
] as const;
export type ReviewRefusalKind = (typeof REVIEW_REFUSAL_KINDS)[number];

export function isReviewRefusalKind(value: unknown): value is ReviewRefusalKind {
  return typeof value === 'string' && (REVIEW_REFUSAL_KINDS as readonly string[]).includes(value);
}

/**
 * What the filer is told, per rule. FIXED TEXT, never the judge's words: a
 * refusal tells the agent to act on its own, and a judge sentence riding on
 * that instruction is exactly where "have another agent do it" came from on
 * 2026-09-16 (`done-when-refusal.ts`). Nothing a judge writes reaches a
 * refused filer.
 */
export const REVIEW_REFUSAL_RULES: Record<ReviewRefusalKind, string> = {
  // team-lead-fleet rules/workflow-conventions.md, "Over $50 of API or eval
  // spend needs explicit approval first" (2026-09-09).
  spend:
    'Spend of $50 or less is your call: the fleet rule asks for approval only over $50 of API or eval spend, so estimate it and run it.',
  // team-lead-fleet skills ship-auto / ship-guarded, and this repo's ship-it:
  // the ship method is the consent, except for push-only repos, D-class
  // actions and ship-guarded's risk pause.
  ship: 'Your ship method already carries consent to push, merge and open the pull request, so go ahead without asking.',
  // team-lead-fleet rules/workflow-conventions.md, "Decision Framework",
  // the Reversible list.
  reversible:
    'A reversible method or implementation choice is yours to make under the fleet Decision Framework, so pick one and log it.',
  // The gate's own rule for owner checks (`OWNER_CHECK_SELF_PREFIX`),
  // widened to every ask. A done-when owner line itself is only ever HELD
  // under it, never refused (`review-gate.ts`).
  'self-check':
    'The answer is a fact you can read yourself from a log, a tracker, an API, a file, a test run or a page you can load, so read it instead of asking.',
  // Bryan, 2026-10-07: "If I ask for a thing, I assume it will be done. If
  // there's an issue with a deadline, then that should be front and center
  // immediately while I'm asking for the thing."
  requested:
    'The reader already asked for this work, so do it and put the conflict (a deadline, a cost) in your reply where they asked; if you truly cannot start without their answer, file an ask that offers a real trade-off and set `blocks` on it.',
};

/**
 * The block of the judge's system turn that teaches it the five rules.
 *
 * Each exception is the half of its rule that keeps an ask legitimate, and
 * is spelled out because a judge that knows only "merges are pre-approved"
 * refuses the force-push and the push-only merge too — both of which are
 * exactly what the reader is for.
 */
export function refusalSystemLines(priorRefusal?: ReviewRefusalKind): string[] {
  const lines = [
    '',
    'Before the criteria, decide whether a rule the agent already works under answers this ask. If one does, the reader must not see it: reply "ok": false and set "refuse" to that rule’s name. There are five rules and only these five:',
    // workflow-conventions.md, "Over $50 of API or eval spend needs explicit
    // approval first".
    '- "spend": it asks approval to spend money on API calls, evals or model runs, and the spend it names is $50 or less. NOT refused when the spend is over $50, or when the item cannot say what it will cost.',
    // ship-auto's D-class list, ship-push-only, and ship-guarded's risk pause.
    '- "ship": it asks whether to push, merge or open a pull request. NOT refused when the item says why consent is not already given: the repo ships push-only so a person merges, or the action is a breaking change on the default branch, a public deploy of a breaking change, an external send, an irreversible delete or a force-push, or it touches a named risk surface (user-facing flows, a removed feature, a schema, a performance-sensitive path) under a guarded ship method.',
    // workflow-conventions.md, "Decision Framework": the Reversible list, and
    // the hard-to-reverse list as its exception.
    '- "reversible": it asks the reader to pick a reversible method or implementation detail — a library or dependency, an approach, naming, file structure, code organization, test strategy, error handling, or the shape of a non-public API. NOT refused when the choice is how something looks, reads or feels to a person, is a product or taste judgement only the reader can make, deletes or loses data, spans several systems, or is an external integration with billing or security stakes.',
    // OWNER_CHECK_SELF_PREFIX's rule, for any ask.
    '- "self-check": it asks the reader for a fact an agent could read itself — a log, an error tracker, an API or command output, a test run, a file, or a page an agent can load in a headless browser. NOT refused when the fact is on a device, account or place only the reader has.',
    // The re-ask: Bryan's benchmark item, 2026-10-07 — "run it anyway, or don't".
    '- "requested": it is a decision about work the reader already asked for, and its options only re-ask whether to do that work — do it, do it anyway, or do not do it. NOT refused when the options offer a real trade-off between different outcomes: a smaller scope now against the full scope later, one approach against another, a cost against a date.',
    'Never refuse an item that says the agent was refused permission — by a permission classifier, a sandbox or a policy — to do the thing itself: that refusal is final, and the reader is the right person to ask.',
    'When you are unsure whether a rule answers the ask, do not refuse it: judge it against the criteria instead. A refusal needs no reason; the gate names the rule itself.',
  ];
  if (priorRefusal !== undefined) {
    lines.push(
      // The appeal. A refusal is not capped like a hold, so the filer's way
      // out is to say why the rule does not reach this ask — and the judge
      // has to be told that saying so is the expected answer.
      `You refused an earlier version of this item under the "${priorRefusal}" rule, and the filer has revised it. Refuse it again only if that rule still answers it. If the item now says why the rule does not apply — a spend over $50, a push-only repo, one of the listed exceptions, a choice only the reader can judge — do not refuse it: judge it against the criteria.`,
    );
  }
  return lines;
}

/** The judge's `refuse` field, read. Anything but a known rule name is no
 *  refusal: an unknown word must never keep an ask from the reader. */
export function readRefusal(parsed: { ok: boolean; refuse?: unknown }):
  | ReviewRefusalKind
  | undefined {
  return !parsed.ok && isReviewRefusalKind(parsed.refuse) ? parsed.refuse : undefined;
}

/**
 * What the gate records when a refusal is dropped because the item reports a
 * permission denial. Fixed words for the reason `REVIEW_REFUSAL_RULES` are.
 */
export const REFUSAL_DENIAL_PASS_REASON =
  'The item reports a permission refusal, which is final, so no fleet rule answers it and the reader is the one to ask.';
