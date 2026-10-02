import { describe, expect, it } from 'bun:test';
import {
  NONE_OPTION_ID,
  assigneeFrom,
  buildChoicePrompt,
  haikuChoiceClassifier,
  parseChoiceReply,
  voiceChoices,
} from '../src/voice-choice.ts';
import type { VoiceClassifyInput } from '../src/voice-classifier.ts';
import type { VoiceResource } from '../src/voice-prompt.ts';

const INDEX = {
  goals: [],
  tasks: [
    { id: 't-time', title: 'Harborlight ferry timetable', status: 'todo' },
    { id: 't-tick', title: 'Harborlight ferry ticketing', status: 'in-progress' },
  ],
  docIds: ['winter-plan'],
  docTitles: { 'winter-plan': 'Winter schedule plan' },
};

const onTask = (transcript: string, resource?: VoiceResource): VoiceClassifyInput => ({
  index: INDEX,
  transcript,
  context: { surface: 'task', taskId: 't-time' },
  resource: resource ?? {
    kind: 'task',
    id: 't-time',
    title: 'Harborlight ferry timetable',
    status: 'todo',
    assignee: '',
    links: [{ kind: 'doc', docId: 'winter-plan' }],
  },
});

describe('voiceChoices', () => {
  it('offers none, every task and doc to open, and the in-view task’s verbs', () => {
    const labels = voiceChoices(onTask('mark this done')).map((o) => o.label);
    expect(labels[0]).toMatch(/^None of these/);
    expect(labels).toContain(
      'Open the task “Harborlight ferry ticketing” (in-progress, on this board)',
    );
    expect(labels).toContain('Open the doc “Winter schedule plan” (on this board)');
    expect(labels).toContain('Set the task in view, “Harborlight ferry timetable” to done');
    expect(labels).toContain(
      'Open the doc linked from the task in view, “Harborlight ferry timetable”',
    );
    // Its own status is not a move.
    expect(labels.some((l) => l.endsWith('to todo'))).toBe(false);
  });

  it('maps each option to the classification the router already executes', () => {
    const opts = voiceChoices(onTask('mark this done'));
    expect(opts.find((o) => o.id === NONE_OPTION_ID)?.classification).toEqual({ kind: 'change' });
    expect(opts.find((o) => o.label.endsWith('to done'))?.classification).toEqual({
      kind: 'action',
      action: 'set-status',
      status: 'done',
      id: 't-time',
    });
  });

  it('turns an assignment that names nobody into a change for the agent', () => {
    const named = voiceChoices(onTask('assign this to Bob')).find((o) =>
      o.label.startsWith('Assign'),
    );
    expect(named?.classification).toMatchObject({ action: 'set-assignee', assignee: 'Bob' });
    const nobody = voiceChoices(onTask('assign this')).find((o) => o.label.startsWith('Assign'));
    expect(nobody?.classification).toEqual({ kind: 'change' });
  });

  it('offers no linked-doc option when the task has two links', () => {
    const two = onTask('open the linked doc', {
      kind: 'task',
      id: 't-time',
      title: 'Harborlight ferry timetable',
      status: 'todo',
      assignee: '',
      links: [
        { kind: 'doc', docId: 'winter-plan' },
        { kind: 'doc', docId: 'berth-plan' },
      ],
    });
    expect(voiceChoices(two).some((o) => o.label.startsWith('Open the doc linked'))).toBe(false);
  });

  it('offers a doc in view a comment and each open question an answer', () => {
    const opts = voiceChoices({
      index: INDEX,
      transcript: 'keep the blue header',
      context: { surface: 'doc', docId: 'booking-mock' },
      resource: {
        kind: 'doc',
        id: 'booking-mock',
        title: 'Harborlight booking page mock',
        reviewItems: [
          {
            threadId: 'th-header',
            commentId: 'c1',
            answerable: true,
            ask: 'Which header?',
            askedBy: 'Bob',
          },
        ],
      },
    });
    const answer = opts.find(
      (o) => o.label === 'Answer the open question in view: “Which header?”',
    );
    expect(answer?.classification).toEqual({
      kind: 'action',
      action: 'answer-review',
      id: 'booking-mock',
    });
    expect(opts.some((o) => o.label.startsWith('Comment on the doc in view'))).toBe(true);
  });
});

describe('assigneeFrom', () => {
  it('reads me, a name after to or for, and "make X the owner"', () => {
    expect(assigneeFrom('assign it to me')).toBe('me');
    expect(assigneeFrom('give this to Bob')).toBe('Bob');
    expect(assigneeFrom('make Alice the owner')).toBe('Alice');
    expect(assigneeFrom('assign this')).toBeUndefined();
  });
});

describe('parseChoiceReply', () => {
  it('reads a fenced reply and clamps the confidence', () => {
    expect(parseChoiceReply('```json\n{"choice":"o2","confidence":1.4}\n```')).toEqual({
      id: 'o2',
      confidence: 1,
    });
  });
  it('reads nothing out of a malformed reply', () => {
    expect(parseChoiceReply('o2')).toEqual({});
    expect(parseChoiceReply('{"choice":')).toEqual({});
  });
});

describe('haikuChoiceClassifier', () => {
  it('asks one question listing every option inside the data fence, and maps the pick', async () => {
    let asked = '';
    const classify = haikuChoiceClassifier(async ({ user }) => {
      asked = user;
      return '{"choice":"o2","confidence":0.8}';
    });
    const out = await classify(onTask('open the ticketing task'));
    expect(asked).toContain('o2: Open the task “Harborlight ferry ticketing”');
    expect(out).toEqual({
      classification: { kind: 'lookup', target: 'task', id: 't-tick' },
      confidence: 0.8,
    });
  });
  it('reads an id that is not an option as no classification', async () => {
    const classify = haikuChoiceClassifier(async () => '{"choice":"o99"}');
    expect((await classify(onTask('anything'))).classification).toBeNull();
  });
  it('keeps the utterance outside the data fence', () => {
    const { user } = buildChoicePrompt(onTask('open it'), voiceChoices(onTask('open it')));
    expect(user.trim().endsWith('Utterance: "open it"')).toBe(true);
  });
});
