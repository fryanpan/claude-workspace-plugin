/**
 * The UserPromptSubmit hook's classifier and post: a prompt is typed unless
 * it starts with a wrapper the harness injects, and the mark it posts says
 * only that, never what the prompt said.
 */
import { describe, expect, it } from 'vitest';
import { decidePromptMark, isTypedPrompt, runPromptHook } from '../hooks/lib/prompt-mark.ts';

const ENV = { CW_AGENT_NAME: 'Harborlight lead', CW_WORKSPACE_ID: 'w-harbor' };
const SECRET = 'Move berth 4 to Riverbend before the tide.';

describe('isTypedPrompt', () => {
  it('reads what a person typed as typed, and each injected wrapper as not', () => {
    expect(isTypedPrompt(SECRET)).toBe(true);
    expect(isTypedPrompt('/ship-it')).toBe(true);
    expect(isTypedPrompt('<b>bold</b> is fine to type')).toBe(true);
    for (const injected of [
      '<channel source="claude-workspaces" doc_id="d-1">Softer shadow?</channel>',
      '\n  <teammate-message teammate_id="team-lead">Rework it</teammate-message>',
      '<task-notification><task-id>b1</task-id></task-notification>',
      '<system-reminder>Tools loaded.</system-reminder>',
      '<cross-session-message from="Riverbend">hi</cross-session-message>',
      'Another Claude session sent a message: hello',
      'This session is being continued from a previous conversation that ran out of context.',
      'Self-wake (keep-moving protocol): check the board.',
    ]) {
      expect(isTypedPrompt(injected)).toBe(false);
    }
  });

  it('has no answer for a payload with no prompt', () => {
    expect(isTypedPrompt(undefined)).toBeUndefined();
    expect(isTypedPrompt('   ')).toBeUndefined();
    expect(isTypedPrompt(7)).toBeUndefined();
  });
});

describe('the mark', () => {
  it('carries typed, session and cwd, and never the prompt', () => {
    const d = decidePromptMark(
      { prompt: SECRET, session_id: 's-1', cwd: '/work/harborlight', hook_event_name: 'x' },
      { agent: 'Harborlight lead', now: 5 },
    );
    expect(d).toEqual({
      post: {
        agent: 'Harborlight lead',
        typed: true,
        sessionId: 's-1',
        cwd: '/work/harborlight',
        at: 5,
      },
    });
    expect(JSON.stringify(d)).not.toContain('berth');
    expect(decidePromptMark({ prompt: SECRET }, { now: 5 })).toEqual({ skip: 'no agent name' });
  });

  it('posts to the board’s prompts route, without the text, and never throws', async () => {
    const calls: { url: string; body: string }[] = [];
    const ok = await runPromptHook(JSON.stringify({ prompt: SECRET, session_id: 's-1' }), {
      env: ENV,
      now: () => 9,
      discoveryPort: () => 8799,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:8799/workspaces/w-harbor/agents/Harborlight%20lead/prompts',
        body: JSON.stringify({ agent: 'Harborlight lead', typed: true, sessionId: 's-1', at: 9 }),
      },
    ]);
    const failing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await runPromptHook('{"prompt":"hi"}', { env: ENV, fetch: failing })).toBe(false);
    expect(await runPromptHook('not json', { env: ENV, fetch: failing })).toBe(false);
    expect(await runPromptHook('{"prompt":"hi"}', { env: {}, fetch: failing })).toBe(false);
  });
});
