/**
 * The gate refuses a decision that only re-asks whether to do the work the
 * reader already asked for, and passes one that offers a real trade-off —
 * through the real filing route and the Home read, with the judge a FAKE.
 *
 * The story: Bryan asked for a benchmark re-run; the agent filed "run it
 * anyway, or don't" because of a deadline, and the work sat idle for two
 * days. The fake refuses under `requested` only when the system turn it is
 * handed teaches that rule AND the options are the do-it-or-not pair, so a
 * prompt that lost the rule turns the refusal into a pass here. Fixtures are
 * invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewJudgePrompt } from '@claude-workspaces/core/review-judge-prompt';
import { REVIEW_REFUSAL_RULES } from '@claude-workspaces/core/review-refusal';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD } from './review-judge-harness.ts';

const RE_ASK = {
  shape: 'decision' as const,
  headline: 'Re-run the Saltmarsh benchmark you asked for?',
  detail: 'You asked for the re-run this morning. It may finish after the Friday cut-off.',
  options: [
    { id: 'o-run', label: 'Run it anyway' },
    { id: 'o-skip', label: "Don't run it" },
  ],
};

const TRADE_OFF = {
  shape: 'decision' as const,
  headline: 'Small Saltmarsh set by Friday, or the full set on Monday?',
  detail: 'You asked for the re-run. The full set misses Friday; the small set makes it.',
  options: [
    { id: 'o-small', label: 'Small set Friday', detail: 'covers 3 of 9 suites' },
    { id: 'o-full', label: 'Full set Monday', detail: 'all 9 suites, three days later' },
  ],
};

const RE_ASK_LABELS = new Set(['run it anyway', "don't run it"]);

/** The fake judge. It reads only what the gate hands it. */
async function fakeJudge(input: ReviewJudgeInput): Promise<ReviewJudgeVerdict> {
  const { system } = buildReviewJudgePrompt(input.criteria, input.item);
  const labels = (input.item.options ?? []).map((o) => o.label.toLowerCase());
  const reAsk = labels.length > 0 && labels.every((l) => RE_ASK_LABELS.has(l));
  if (reAsk && system.includes('- "requested":')) {
    return { ok: false, reason: 'It only re-asks.', refuse: 'requested' };
  }
  return { ok: true, reason: 'A real choice.' };
}

let handle: ServerHandle | undefined;
let dataDir = '';
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a decision that re-asks requested work', () => {
  it('is refused with the do-the-work instruction, and a real trade-off reaches Home', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'requested-refusal-'));
    handle = createServer({ port: 0, dataDir, reviewJudge: fakeJudge, keepMovingCadenceMs: 0 });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r.ok, await r.clone().text()).toBe(true);
      return (await r.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Saltmarsh', leadAgentId: LEAD.id })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const taskId = (
      (await post(`/workspaces/${ws}/tasks`, {
        title: 'Re-run the Saltmarsh benchmark',
        body: 'Alice can see the Saltmarsh numbers so that she can pick a release.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      })) as { task: { id: string } }
    ).task.id;

    const refused = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: FILER,
      review: RE_ASK,
    })) as { held?: boolean; refused?: string; message?: string; item?: { id: string } };
    expect(refused.held).toBe(true);
    expect(refused.refused).toBe('requested');
    expect(refused.message).toContain(REVIEW_REFUSAL_RULES.requested);
    expect(refused.message).toContain('so do it');

    const passed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: FILER,
      review: TRADE_OFF,
    })) as { held?: boolean; item?: { id: string } };
    expect(passed.held).toBeUndefined();

    const home = (
      (await (await fetch(`${base}/workspaces/${ws}/review-items`)).json()) as {
        items: Array<{ reviewItemId?: string }>;
      }
    ).items.map((r) => r.reviewItemId);
    // Positive control first: the same read shows the trade-off.
    expect(home).toContain(passed.item?.id);
    expect(home).not.toContain(refused.item?.id);
  });
});
