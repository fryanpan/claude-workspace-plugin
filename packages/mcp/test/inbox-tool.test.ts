/**
 * `post_inbox_rows` sends the reader's pass to the one route that stores
 * message rows, under this session's own id, and lets the server judge the
 * rows and the caller.
 */
import { describe, expect, it } from 'vitest';
import { handleInboxTool } from '../src/tools/inbox.ts';

function recorder(answer: (path: string) => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer(path);
    },
    ok: (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] }),
    err: (message: string) => ({
      isError: true,
      content: [{ type: 'text' as const, text: message }],
    }),
    AUTHOR: { id: 'agent-reader', name: 'Reader', kind: 'agent' as const },
  };
  return { calls, ctx };
}

describe('post_inbox_rows', () => {
  it('posts the pass and rows to /inbox/rows under its own agent id', async () => {
    const r = recorder(() => ({ ok: true, accepted: 1, created: 1, updated: 0, rejected: [] }));
    const rows = [{ dedupeKey: 'gmail:abc', agentId: 'someone-else' }];
    const out = await handleInboxTool('post_inbox_rows', { pass: 'p1', rows }, r.ctx as never);
    expect(r.calls).toEqual([
      ['POST', '/inbox/rows', { agentId: 'agent-reader', pass: 'p1', rows }],
    ]);
    expect(JSON.stringify(out)).toContain('\\"created\\":1');
  });

  it('cannot be pointed at another agent id by an argument', async () => {
    const r = recorder(() => ({}));
    await handleInboxTool(
      'post_inbox_rows',
      { pass: 'p1', rows: [{}], agentId: 'agent-mira' },
      r.ctx as never,
    );
    expect((r.calls[0]?.[2] as { agentId: string }).agentId).toBe('agent-reader');
  });

  it('refuses an empty pass before anything leaves the process', async () => {
    const r = recorder(() => ({}));
    const noRows = await handleInboxTool(
      'post_inbox_rows',
      { pass: 'p1', rows: [] },
      r.ctx as never,
    );
    const noPass = await handleInboxTool('post_inbox_rows', { rows: [{}] }, r.ctx as never);
    expect(noRows?.isError).toBe(true);
    expect(noPass?.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it("surfaces the server's refusal of a caller that is not the reader", async () => {
    const r = recorder(() => {
      throw new Error('POST /inbox/rows → 403: not-the-inbox-reader');
    });
    await expect(
      handleInboxTool('post_inbox_rows', { pass: 'p1', rows: [{}] }, r.ctx as never),
    ).rejects.toThrow('not-the-inbox-reader');
  });

  it('answers undefined for a name that is not its own', async () => {
    const r = recorder(() => ({}));
    expect(await handleInboxTool('post_status', {}, r.ctx as never)).toBeUndefined();
  });
});
