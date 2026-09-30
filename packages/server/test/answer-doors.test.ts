import { describe, expect, it } from 'bun:test';
import {
  GRANT_ANSWER_DENIAL,
  SECRET_ANSWER_DENIAL,
  answerDoorRefusal,
} from '../src/review-items/answer-doors.ts';

describe('which door may answer a secret or grant item', () => {
  it('refuses every free-text door, and the other shape’s door', () => {
    expect(answerDoorRefusal('secret', undefined)).toBe(SECRET_ANSWER_DENIAL);
    expect(answerDoorRefusal('secret', 'grant')).toBe(SECRET_ANSWER_DENIAL);
    expect(answerDoorRefusal('grant', undefined)).toBe(GRANT_ANSWER_DENIAL);
    expect(answerDoorRefusal('grant', 'secret')).toBe(GRANT_ANSWER_DENIAL);
  });

  it('admits each shape through its own door, and every other shape anywhere', () => {
    expect(answerDoorRefusal('secret', 'secret')).toBeUndefined();
    expect(answerDoorRefusal('grant', 'grant')).toBeUndefined();
    for (const shape of ['decision', 'review', undefined]) {
      expect(answerDoorRefusal(shape, undefined)).toBeUndefined();
    }
  });
});
