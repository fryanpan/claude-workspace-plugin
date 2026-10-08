import { describe, expect, it } from 'vitest';
import {
  type VoiceBoardRow,
  pickLine,
  pickSearch,
  startingPick,
} from '../src/voice-page/voice-page-model.ts';

const BOARDS: VoiceBoardRow[] = [
  {
    id: 'w-1',
    name: 'Harborlight',
    agents: [
      { agentId: 'harborlight-lead', name: 'Harborlight Lead', listening: false, lead: true },
      { agentId: 'riverbend', name: 'Riverbend', listening: false, lead: false },
    ],
  },
  {
    id: 'w-2',
    name: 'Saltmarsh',
    agents: [{ agentId: 'riverbend', name: 'Riverbend', listening: true, lead: false }],
  },
];

describe('startingPick', () => {
  it('starts on the URL’s agent, on the board where it is listening', () => {
    const { pick } = startingPick(BOARDS, { agent: 'riverbend' });
    expect([pick?.board.id, pick?.agent.agentId]).toEqual(['w-2', 'riverbend']);
  });

  it('the URL’s board wins when it names one', () => {
    const { pick } = startingPick(BOARDS, { agent: 'riverbend', board: 'w-1' });
    expect(pick?.board.id).toBe('w-1');
  });

  it('with no agent named, the last one this browser talked to, else the first lead', () => {
    expect(startingPick(BOARDS, {}, { agent: 'riverbend', board: 'w-1' }).pick?.board.id).toBe(
      'w-1',
    );
    expect(startingPick(BOARDS, {}).pick?.agent.agentId).toBe('harborlight-lead');
  });

  it('an agent on none of the boards is named as missing, not silently swapped', () => {
    const r = startingPick(BOARDS, { agent: 'bob' });
    expect(r.missing).toBe('bob');
    expect(r.pick?.agent.agentId).toBe('harborlight-lead');
  });

  it('nobody attached anywhere picks nobody', () => {
    expect(startingPick([], { agent: 'bob' }).pick).toBeNull();
  });
});

describe('the pick, said and addressed', () => {
  const pick = { board: BOARDS[1] as VoiceBoardRow, agent: BOARDS[1]?.agents[0] as never };

  it('names who hears the next question and whether they hear it now', () => {
    expect(pickLine(pick)).toBe('Talking to Riverbend on Saltmarsh · listening now');
  });

  it('is an address a reload or a Shortcut lands on', () => {
    expect(pickSearch(pick)).toBe('?agent=riverbend&board=w-2');
  });
});
