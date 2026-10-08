/**
 * A page names the agent it talks to in `start`. The id is checked against
 * the board on the server; here it only has to be an id, not a path or prose.
 */
import { describe, expect, it } from 'vitest';
import { parseSpokenClientMessage } from '../src/spoken-reply.ts';

const start = (extra: Record<string, unknown>) =>
  parseSpokenClientMessage(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', ...extra }));

describe('start.agent', () => {
  it('carries an agent id through', () => {
    expect(start({ agent: 'harborlight-lead' })).toMatchObject({
      type: 'start',
      agent: 'harborlight-lead',
    });
  });

  it('drops a value that is not an id, and keeps the start', () => {
    for (const agent of ['', 'two words', '../w-1', 'a\\b', 'x'.repeat(201), 7]) {
      const m = start({ agent });
      expect(m?.type).toBe('start');
      expect(m && 'agent' in m).toBe(false);
    }
  });
});
