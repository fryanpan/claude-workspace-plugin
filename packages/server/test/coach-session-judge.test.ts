/**
 * The coach's session judge: a candidate goes to the Coach board's lead as
 * one addressed frame, and the session's reply settles the judgement; no
 * lead, no stream, a lapsed or unknown candidate each settle to no answer.
 */
import { describe, expect, it } from 'bun:test';
import { ANSWER_WITHIN_MS, type CandidateFrame, SessionJudge } from '../src/coach/session-judge.ts';
import { waitFor } from './wait-for.ts';

const PROMPT = { system: 'You are Saltmarsh.', user: 'It is Wednesday, 10:10 his time.' };
const LEAD = { workspaceId: 'w-coach', agentId: 'coach-session' };

function judge(
  opts: { lead?: typeof LEAD | null; streams?: number; within?: number; listening?: boolean } = {},
) {
  const sent: { workspaceId: string; agentId: string; frame: CandidateFrame }[] = [];
  const j = new SessionJudge({
    lead: () => (opts.lead === undefined ? LEAD : opts.lead),
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame });
      return opts.streams ?? 1;
    },
    now: () => 1_000,
    connected: () => opts.listening ?? true,
    ...(opts.within !== undefined ? { answerWithinMs: opts.within } : {}),
  });
  return { j, sent };
}

describe('SessionJudge', () => {
  it('sends the lead one frame with the prompt and a reply path, and the reply settles it', async () => {
    const { j, sent } = judge();
    const answer = j.generate(PROMPT);
    expect(sent).toHaveLength(1);
    const { frame, ...to } = sent[0] ?? ({} as never);
    expect(to).toEqual(LEAD);
    expect(frame).toMatchObject({
      event: 'coach.candidate',
      workspaceId: 'w-coach',
      at: 1_000,
      ...{ system: PROMPT.system, prompt: PROMPT.user },
    });
    expect(frame.replyPath).toBe(`/coach/candidates/${frame.candidateId}/reply`);
    expect(j.reply(frame.candidateId, '{"verdict":"quiet"}')).toBe(true);
    expect(await answer).toBe('{"verdict":"quiet"}');
    expect(j.reply(frame.candidateId, '{"verdict":"quiet"}')).toBe(false);
    expect(j.waiting).toBe(0);
  });

  it('asks nothing with no lead, and settles at once when no stream took the frame', async () => {
    const none = judge({ lead: null });
    expect(none.j.reachable()).toBe(false);
    expect(await none.j.generate(PROMPT)).toBeNull();
    expect(none.sent).toHaveLength(0);
    expect(judge({ listening: false }).j.reachable()).toBe(false);
    expect(judge().j.reachable()).toBe(true);
    const deaf = judge({ streams: 0 });
    expect(await deaf.j.generate(PROMPT)).toBeNull();
    expect(deaf.j.waiting).toBe(0);
  });

  it('a candidate the session leaves unanswered lapses, and an unknown id is refused', async () => {
    const { j } = judge({ within: 20 });
    let settled: string | null | undefined;
    void j.generate(PROMPT).then((r) => {
      settled = r;
    });
    await waitFor(() => settled !== undefined);
    expect(settled).toBeNull();
    expect(j.reply('cc-aaaaaaaaaaaa', '{}')).toBe(false);
    expect(j.reply('../etc', '{}')).toBe(false);
    expect(ANSWER_WITHIN_MS).toBe(3 * 60_000);
  });
});
