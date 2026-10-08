/**
 * The voice API on Workspaces boards: one model per agent, and a turn sent
 * to the board where that agent is listening, else the one it leads.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentVoiceFrame } from '../src/spoken-reply/agent-conversation.ts';
import { LeadAnswers } from '../src/spoken-reply/lead-answer.ts';
import type { VoiceBoard } from '../src/voice-agent-list.ts';
import { workspacesVoiceAgents } from '../src/voice-api/backend.ts';

const agent = (agentId: string, name: string, listening = false, lead = false) => ({
  agentId,
  name,
  listening,
  lead,
});

const BOARDS: VoiceBoard[] = [
  {
    id: 'w-harbor',
    name: 'Harborlight',
    agents: [agent('riverbend-helper', 'Riverbend Helper', false, true)],
  },
  {
    id: 'w-salt',
    name: 'Saltmarsh',
    agents: [agent('riverbend-helper', 'Riverbend Helper', true), agent('bob-agent', 'Bob')],
  },
];

function backend(boards = BOARDS, delivered: number | null = 1) {
  const frames: AgentVoiceFrame[] = [];
  const leads = new LeadAnswers();
  let n = 0;
  const agents = workspacesVoiceAgents({
    boards: () => boards,
    line: {
      attached: () => undefined,
      deliver: (f) => {
        frames.push(f);
        return delivered;
      },
    },
    leads,
    newId: () => `q${++n}`,
    now: () => 5,
  });
  return { agents, frames, leads };
}

const TURN = {
  text: 'how far is Harborlight',
  history: [{ from: 'owner' as const, text: 'hello' }],
  conversationId: 'c1',
  speaker: { id: 'known-alice', name: 'Alice' },
};

describe('workspacesVoiceAgents', () => {
  it('lists each agent once, placed where it is listening', () => {
    const { agents } = backend();
    expect(agents.list()).toEqual([
      {
        id: 'riverbend-helper',
        name: 'Riverbend Helper',
        description: 'On Saltmarsh, listening now',
      },
      { id: 'bob-agent', name: 'Bob', description: 'On Saltmarsh' },
    ]);
  });

  it('sends a turn to the listening board, addressed to that agent alone', () => {
    const { agents, frames, leads } = backend();
    const replies: string[] = [];
    const sent = agents.send({ ...TURN, agentId: 'riverbend-helper' }, (t) => replies.push(t));
    expect(sent).toEqual({ kind: 'sent', name: 'Riverbend Helper' });
    expect(frames[0]).toMatchObject({
      workspaceId: 'w-salt',
      route: 'agent',
      to: 'riverbend-helper',
      transcript: TURN.text,
      queueId: 'q1',
      conversationId: 'c1',
      conversation: TURN.history,
      actor: { id: 'known-alice', name: 'Alice' },
    });
    // Only the addressed agent's answer reaches the turn.
    expect(leads.answer('w-salt', 'q1', 'Wrong one.', undefined, 'bob-agent')).toBe(false);
    expect(leads.answer('w-salt', 'q1', 'Twelve miles.', undefined, 'riverbend-helper')).toBe(true);
    expect(replies).toEqual(['Twelve miles.']);
  });

  it('falls back to the board it leads, then reports away or failed or unknown', () => {
    const quiet = BOARDS.map((b) => ({
      ...b,
      agents: b.agents.map((a) => ({ ...a, listening: false })),
    }));
    const a = backend(quiet, 0);
    expect(a.agents.send({ ...TURN, agentId: 'riverbend-helper' }, () => {})).toEqual({
      kind: 'queued',
      name: 'Riverbend Helper',
    });
    expect(a.frames[0]?.workspaceId).toBe('w-harbor');
    expect(backend(BOARDS, null).agents.send({ ...TURN, agentId: 'bob-agent' }, () => {})).toEqual({
      kind: 'failed',
    });
    expect(backend().agents.send({ ...TURN, agentId: 'nobody' }, () => {})).toEqual({
      kind: 'unknown',
    });
  });
});
