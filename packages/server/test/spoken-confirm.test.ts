/**
 * The read-back step on its own: nothing commits without a yes, a refusal
 * commits nothing, and the undo window is exactly one utterance long.
 */
import { describe, expect, it } from 'bun:test';
import { Confirm, type Proposal } from '../src/spoken-reply/confirm.ts';

const APPROVE: Proposal = { text: 'Approve', optionId: 'o-approve' };
const REWORK: Proposal = { text: 'Rework', optionId: 'o-rework' };

function pickFrom(said: string): Proposal | null {
  if (/rework|second/.test(said)) return REWORK;
  if (/approve|first/.test(said)) return APPROVE;
  return null;
}

describe('Confirm', () => {
  it('reads the proposal back and waits', () => {
    const c = new Confirm<string>();
    expect(c.propose(APPROVE)).toEqual(['Recording: Approve.', 'OK?']);
    expect(c.confirming).toBe(true);
    expect(c.undoable).toBe(false);
  });

  it('a yes hands back the proposal; commit opens the undo window', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    expect(c.judge('yes please', pickFrom)).toEqual({ kind: 'yes', proposal: APPROVE });
    expect(c.confirming).toBe(false);
    const id = c.commit('item-1');
    expect(c.undoable).toBe(true);
    const back = c.takeBack('undo that');
    expect(back?.subject).toBe('item-1');
    expect(back?.id).not.toBe(id);
  });

  it('a bare no or wait commits nothing and leaves no read-back pending', () => {
    for (const said of ['no', 'wait', 'hold on']) {
      const c = new Confirm<string>();
      c.propose(APPROVE);
      expect(c.judge(said, pickFrom)).toEqual({ kind: 'no' });
      expect(c.confirming).toBe(false);
      expect(c.undoable).toBe(false);
    }
  });

  it('"no, the second one" names a different proposal', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    expect(c.judge('no, the second one', pickFrom)).toEqual({ kind: 'other', proposal: REWORK });
  });

  it('stop ends the read-back without committing', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    expect(c.judge('stop', pickFrom)).toEqual({ kind: 'stop' });
    expect(c.confirming).toBe(false);
  });

  it('words that are neither yes nor no ask again and keep the read-back', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    expect(c.judge('hmm', pickFrom)).toEqual({
      kind: 'unclear',
      say: ['Say yes to record Approve, or no.'],
    });
    expect(c.confirming).toBe(true);
    expect(c.judge('yes', pickFrom).kind).toBe('yes');
  });

  it('the undo window closes after one utterance, whatever it was', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    c.judge('yes', pickFrom);
    c.commit('item-1');
    expect(c.takeBack('skip')).toBeNull();
    expect(c.undoable).toBe(false);
    expect(c.takeBack('undo that')).toBeNull();
  });

  it('a bare no right after a commit takes it back', () => {
    const c = new Confirm<string>();
    c.propose(APPROVE);
    c.judge('yes', pickFrom);
    c.commit('item-1');
    expect(c.takeBack('no')?.subject).toBe('item-1');
  });

  it('settled names a failed write, once, and closes its undo window', () => {
    const c = new Confirm<string>();
    const id = c.commit('item-1');
    expect(c.settled(id, false)).toEqual({ subject: 'item-1', action: 'record' });
    expect(c.undoable).toBe(false);
    expect(c.settled(id, false)).toBeNull();
  });

  it('settled is silent for a write that went through, and for an unknown id', () => {
    const c = new Confirm<string>();
    const id = c.commit('item-1');
    expect(c.settled(id, true)).toBeNull();
    expect(c.undoable).toBe(true);
    expect(c.settled('d99', false)).toBeNull();
  });

  it('a failed undo is reported as an undo', () => {
    const c = new Confirm<string>();
    c.commit('item-1');
    const back = c.takeBack('take that back');
    expect(back).not.toBeNull();
    expect(c.settled(back?.id ?? '', false)).toEqual({ subject: 'item-1', action: 'undo' });
  });

  it('reset drops a pending read-back and the undo window', () => {
    const c = new Confirm<string>();
    c.commit('item-1');
    c.propose(APPROVE);
    c.reset();
    expect(c.confirming).toBe(false);
    expect(c.undoable).toBe(false);
  });
});
