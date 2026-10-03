/**
 * The coach session's half of a candidate: the line it reads carries the
 * whole question and names the reply, and `coach_reply` posts the verdict to
 * the candidate's route, telling the session when the candidate had lapsed.
 */
import { describe, expect, it } from 'vitest';
import { coachCandidateLine } from '../src/coach-line.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

const FRAME = {
  candidateId: 'cc-aaaaaaaaaaaa',
  system: 'You are Saltmarsh, a calm coach. Your default is to stay quiet.',
  prompt: 'Right now: 24 min active on "Button hover states mock" on board "Harborlight".',
};

describe('coachCandidateLine', () => {
  it('carries the rules, what they are doing, and the reply to send', () => {
    const line = coachCandidateLine(FRAME) ?? '';
    expect(line.startsWith('[coach.candidate]')).toBe(true);
    expect(line).toContain('coach_reply(candidateId="cc-aaaaaaaaaaaa", verdict)');
    expect(line).toContain('claude-workspaces:coaching');
    expect(line).toContain(FRAME.system);
    expect(line).toContain(FRAME.prompt);
  });

  it('says nothing for a frame with no candidate to answer', () => {
    expect(coachCandidateLine({ system: FRAME.system })).toBeNull();
  });
});

function ctxFor(answer: (path: string) => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer(path);
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  };
  return { calls, ctx: ctx as never };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

describe('coach_reply', () => {
  it('posts the verdict to the candidate it names', async () => {
    const { calls, ctx } = ctxFor(() => ({ ok: true }));
    const verdict = { verdict: 'quiet' };
    const r = await handleWorkspaceTool(
      'coach_reply',
      { candidateId: FRAME.candidateId, verdict },
      ctx,
    );
    expect(calls).toEqual([['POST', '/coach/candidates/cc-aaaaaaaaaaaa/reply', verdict]]);
    expect(JSON.parse(text(r))).toEqual({ settled: true });
  });

  it('tells the session a lapsed candidate settled nothing, and refuses a verdict that is not an object', async () => {
    const { ctx } = ctxFor(() => {
      throw new Error(
        'POST /coach/candidates/cc-aaaaaaaaaaaa/reply → 404: {"error":"no-such-candidate"}',
      );
    });
    const lapsed = await handleWorkspaceTool(
      'coach_reply',
      { candidateId: FRAME.candidateId, verdict: { verdict: 'quiet' } },
      ctx,
    );
    expect(JSON.parse(text(lapsed))).toMatchObject({ settled: false });
    const bad = await handleWorkspaceTool(
      'coach_reply',
      { candidateId: FRAME.candidateId, verdict: 'quiet' },
      ctx,
    );
    expect(bad).toMatchObject({ isError: true });
  });
});
