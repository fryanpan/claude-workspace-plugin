import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.ts';
import { jsonClassifier } from '../src/voice-classifier.ts';
import { VoiceRouter } from '../src/voice.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

describe('jsonClassifier', () => {
  it('asks the shipped prompt once and parses its reply', async () => {
    const prompts: string[] = [];
    const classify = jsonClassifier(async ({ user }) => {
      prompts.push(user);
      return '{"kind":"lookup","target":"task","id":"t-1"}';
    });
    const out = await classify({
      index: {
        goals: [],
        tasks: [{ id: 't-1', title: 'Riverbend berth survey', status: 'todo' }],
        docIds: [],
      },
      transcript: 'open the berth survey',
    });
    expect(out).toEqual({ classification: { kind: 'lookup', target: 'task', id: 't-1' } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Riverbend berth survey');
  });
});

describe('VoiceRouter with an injected classifier', () => {
  it('runs the classifier’s pick through the router as the shipped one would be', async () => {
    const store = new TaskStore({
      dataDir: mkdtempSync(join(tmpdir(), 'cw-classifier-')),
      debounceMs: 1,
    });
    const ws = store.createWorkspace('Harborlight');
    const made = store.createTask(ws.id, { title: 'Saltmarsh parking signs', actor: ALICE });
    if (!made.ok) throw new Error('fixture task refused');
    const asked: string[] = [];
    const router = new VoiceRouter({
      tasks: store,
      classify: async ({ transcript }) => {
        asked.push(transcript);
        return { classification: { kind: 'lookup', target: 'task', id: made.task.id } };
      },
    });
    const res = await router.handle(ws.id, {
      transcript: 'pull up the car park thing',
      actor: ALICE,
    });
    expect(asked).toEqual(['pull up the car park thing']);
    expect(res.ok && res.navigate).toContain(`task=${made.task.id}`);
  });
});
