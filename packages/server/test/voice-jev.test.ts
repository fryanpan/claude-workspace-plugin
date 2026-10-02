/**
 * The Jev arm, with no call made. The reply fixture below is the ASSUMED
 * shape (`voice-jev.ts` header): no exchange with TypeSafe has been recorded,
 * because sending workspace text there is not yet approved. Replace it with
 * a recorded reply when one exists.
 */
import { describe, expect, it } from 'bun:test';
import { CHOICE_DEFINITIONS, NONE_OPTION_ID, voiceChoices } from '../src/voice-choice.ts';
import type { VoiceClassifyInput } from '../src/voice-classifier.ts';
import {
  type JevRequest,
  buildJevRequest,
  jevClassifier,
  parseJevResponse,
} from '../src/voice-jev.ts';

const INPUT: VoiceClassifyInput = {
  index: {
    goals: [],
    tasks: [
      { id: 't-time', title: 'Harborlight ferry timetable', status: 'todo' },
      { id: 't-tick', title: 'Harborlight ferry ticketing', status: 'in-progress' },
    ],
    docIds: [],
  },
  transcript: 'open the ticketing task',
  context: { surface: 'board' },
};

/** Assumed shape: the picked id, and a probability per option. */
const ASSUMED_REPLY = { choice: 'o2', probabilities: { none: 0.05, o1: 0.07, o2: 0.88 } };

describe('buildJevRequest', () => {
  it('asks ONE choice question over every route plus none, with the definitions', () => {
    const options = voiceChoices(INPUT);
    const req = buildJevRequest(INPUT, options);
    expect(req.question.type).toBe('choice');
    // Every option, by its id and label and nothing else, none first.
    expect(req.question.options).toEqual(options.map((o) => ({ id: o.id, label: o.label })));
    expect(req.question.options[0]?.id).toBe(NONE_OPTION_ID);
    expect(req.question.options).toContainEqual({
      id: 'o2',
      label: 'Open the task “Harborlight ferry ticketing” (in-progress, on this board)',
    });
    expect(req.question.definitions).toBe(CHOICE_DEFINITIONS.join('\n'));
    expect(req.input).toBe(
      'The speaker is on the board.\nThe speaker said: "open the ticketing task"',
    );
  });
});

describe('parseJevResponse', () => {
  it('reads the pick and its probability', () => {
    expect(parseJevResponse(ASSUMED_REPLY)).toEqual({
      id: 'o2',
      confidence: 0.88,
      probabilities: ASSUMED_REPLY.probabilities,
    });
  });
  it('drops a probability outside 0..1 and reads a malformed body as no pick', () => {
    expect(parseJevResponse({ choice: 'o1', probabilities: { o1: 3 } })).toEqual({
      id: 'o1',
      probabilities: {},
    });
    expect(parseJevResponse('o2')).toEqual({ probabilities: {} });
    expect(parseJevResponse(null)).toEqual({ probabilities: {} });
  });
});

describe('jevClassifier', () => {
  it('sends the built request through the injected transport and maps the pick', async () => {
    const sent: JevRequest[] = [];
    const classify = jevClassifier(async (req) => {
      sent.push(req);
      return ASSUMED_REPLY;
    });
    expect(await classify(INPUT)).toEqual({
      classification: { kind: 'lookup', target: 'task', id: 't-tick' },
      confidence: 0.88,
    });
    expect(sent).toHaveLength(1);
  });
});
