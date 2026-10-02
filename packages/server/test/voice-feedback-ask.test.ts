/**
 * The rule over the tidier's proposed question, and the spoken answers it
 * matches without a model call. Synthetic fixtures — the Riverbend register.
 */
import { describe, expect, it } from 'bun:test';
import type { VoiceTarget } from '@claude-workspaces/core';
import {
  type AskContext,
  type AskProposal,
  type PendingAsk,
  answerFromWords,
  decideAsk,
  readAskProposal,
} from '../src/voice-feedback-ask.ts';
import { buildTidyPrompt, parseTidyReply } from '../src/voice-feedback-tidy.ts';

const TARGETS: VoiceTarget[] = [
  { i: 0, tag: 'header', text: 'Riverbend' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 2, tag: 'footer', text: 'Harborlight' },
  { i: 3, tag: 'button', text: 'Save', parent: 2 },
  { i: 4, tag: 'button', text: 'Cancel', parent: 2 },
];

const WHICH: AskProposal = {
  question: 'Which Save button?',
  choices: [
    { label: 'Save in the header', element: 1 },
    { label: 'Save in the footer', element: 3 },
  ],
};

const ctx = (over: Partial<AskContext> = {}): AskContext => ({
  key: 'v1',
  fixed: false,
  asked: false,
  words: 'this one is too small',
  targets: TARGETS,
  ...over,
});

describe('decideAsk', () => {
  it('lets an element question stand when the words only point', () => {
    expect(decideAsk(WHICH, ctx()).ask).toMatchObject({ about: 'anchor', key: 'v1' });
  });

  it('lets one stand when the elements look alike, even if the words name them', () => {
    expect(decideAsk(WHICH, ctx({ words: 'the save button is too small' })).ask).not.toBeNull();
  });

  it('drops an element question when the words name an element that has no twin', () => {
    const p: AskProposal = {
      question: 'Which button?',
      choices: [
        { label: 'Save', element: 3 },
        { label: 'Cancel', element: 4 },
      ],
    };
    expect(decideAsk(p, ctx({ words: 'the cancel button is grey' }))).toEqual({
      ask: null,
      why: 'element named',
    });
  });

  it('never asks where a note goes that the person placed, or asks twice', () => {
    expect(decideAsk(WHICH, ctx({ fixed: true }))).toMatchObject({ why: 'placed by the person' });
    expect(decideAsk(WHICH, ctx({ asked: true }))).toMatchObject({ why: 'already asked' });
  });

  it('asks what a note means only with two or three distinct rewrites', () => {
    const meaning: AskProposal = {
      question: 'Bigger, or bolder?',
      choices: [
        { label: 'Bigger', text: 'Make the title bigger.' },
        { label: 'Bolder', text: 'Make the title bolder.' },
      ],
    };
    expect(decideAsk(meaning, ctx({ fixed: true })).ask).toMatchObject({ about: 'meaning' });
    const same = { ...meaning, choices: meaning.choices.map((c) => ({ ...c, text: 'X.' })) };
    expect(decideAsk(same, ctx())).toMatchObject({ why: 'choices repeat' });
  });

  it('drops a question too long to say in a breath, or one with a single choice', () => {
    const long = {
      ...WHICH,
      question: 'Could you tell me which of the two Save buttons on this page you mean?',
    };
    expect(decideAsk(long, ctx())).toMatchObject({ why: 'not a short question' });
    expect(decideAsk({ ...WHICH, choices: WHICH.choices.slice(0, 1) }, ctx())).toMatchObject({
      why: 'not two or three choices',
    });
    expect(decideAsk(undefined, ctx())).toMatchObject({ why: 'none proposed' });
  });
});

describe('answerFromWords', () => {
  const ask: PendingAsk = { key: 'v1', about: 'anchor', ...WHICH };

  it('reads ordinals, labels and a skip', () => {
    expect(answerFromWords(ask, 'the second one')).toBe(1);
    expect(answerFromWords(ask, 'first')).toBe(0);
    expect(answerFromWords(ask, 'the footer')).toBe(1);
    expect(answerFromWords(ask, 'header please')).toBe(0);
    expect(answerFromWords(ask, 'never mind')).toBe('skip');
  });

  it('leaves anything that is not plainly one choice to the model', () => {
    expect(answerFromWords(ask, 'save')).toBeNull();
    expect(
      answerFromWords(ask, 'actually the one under the logo near the top of the page'),
    ).toBeNull();
    expect(answerFromWords(ask, '')).toBeNull();
  });
});

describe('the tidy reply carries the proposal', () => {
  it('reads an ask off a comment, keeping only catalog elements', () => {
    const input = { targets: TARGETS, open: null, words: 'this one is too small' };
    const [c] =
      parseTidyReply(
        JSON.stringify({
          comments: [
            {
              text: 'This Save button is too small.',
              element: 'e1',
              ask: {
                question: 'Which Save button?',
                choices: [
                  { label: 'Header', element: 'e1' },
                  { label: 'Elsewhere', element: 'e99' },
                ],
              },
            },
          ],
        }),
        input,
      ) ?? [];
    expect(c?.ask?.choices).toEqual([{ label: 'Header', element: 1 }, { label: 'Elsewhere' }]);
    expect(readAskProposal('nope', new Set())).toBeNull();
  });

  it('shows the model the question waiting and the reading already chosen', () => {
    const { user } = buildTidyPrompt({
      targets: TARGETS,
      open: {
        text: 'Make it pop.',
        raw: 'make it pop',
        target: 1,
        fixed: false,
        clarified: 'Bolder',
      },
      words: 'the bigger one',
      asked: { question: 'Bigger, or bolder?', choices: ['Bigger', 'Bolder'] },
    });
    expect(user).toContain('<clarified>Bolder</clarified>');
    expect(user).toContain(
      '<asked question="Bigger, or bolder?"><choice>Bigger</choice><choice>Bolder</choice></asked>',
    );
  });
});
