/**
 * Voice quick actions: what the board mic does on the page with no agent —
 * another board, a plan or a meeting, feedback about the app, help — and the
 * status question that goes to a live lead instead of the brief.
 *
 * The detectors first, then the whole route with a completer that always
 * fails, so a case that passes was decided by the words alone. Names are the
 * house fixture names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_FEEDBACK_DOC_ID } from '../src/doc-ids.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  FEEDBACK_ASK,
  FEEDBACK_SAVED_ACK,
  HELP_SPOKEN,
  boardAsk,
  feedbackAsk,
  helpAsk,
  openingAck,
  quickAckFits,
  startAsk,
} from '../src/voice-quick.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';

const BOARDS = [
  { id: 'w-lead', name: 'Harborlight Team Lead' },
  { id: 'w-crew', name: 'Riverbend Crew' },
  { id: 'w-ops', name: 'Harborlight Ops' },
];

describe('the detectors', () => {
  it('boardAsk: Bryan’s two phrasings of the Team Lead board, and a loose one', () => {
    expect(boardAsk('switch to the Team Leads workspace', BOARDS)?.board.id).toBe('w-lead');
    expect(boardAsk("take me to the Team Lead's board", BOARDS)?.board.id).toBe('w-lead');
    expect(boardAsk("let's go over to the Riverbend crew board", BOARDS)?.board.id).toBe('w-crew');
  });

  it('boardAsk: no board word, an even split, or no boards is not a hit', () => {
    expect(boardAsk('take me to Riverbend Crew', BOARDS)).toBeNull();
    expect(boardAsk('go to the Harborlight board', BOARDS)).toBeNull();
    expect(boardAsk('switch to the crew board', [])).toBeNull();
    expect(boardAsk('the crew board is slow', BOARDS)).toBeNull();
  });

  it('startAsk: the two start buttons, and "open the plan" is not one', () => {
    expect(startAsk('make a plan')).toBe('plan');
    expect(startAsk("let's make a plan for the ferry launch")).toBe('plan');
    expect(startAsk('can we have a meeting')).toBe('meeting');
    expect(startAsk('start a new meeting')).toBe('meeting');
    expect(startAsk('open the plan')).toBeNull();
    expect(startAsk('the meeting went long')).toBeNull();
  });

  it('feedbackAsk: the words after the prefix, empty when none were said', () => {
    expect(feedbackAsk('feedback: the mic is hard to find')).toEqual({
      body: 'the mic is hard to find',
    });
    expect(feedbackAsk('leave feedback that the mic is hard to find')).toEqual({
      body: 'the mic is hard to find',
    });
    expect(feedbackAsk('I want to leave feedback')).toEqual({ body: '' });
    expect(feedbackAsk('what feedback did Bob leave on the berth plan')).toBeNull();
  });

  it('helpAsk: Bryan’s phrasing, and a question that only mentions help is not one', () => {
    expect(helpAsk('what can I do with voice commands')).toBe(true);
    expect(helpAsk('help')).toBe(true);
    expect(helpAsk('help me draft the winter schedule')).toBe(false);
  });

  it('openingAck keeps a long name inside the cap', () => {
    const ack = openingAck('Riverbend issues list meeting minutes from the spring');
    expect(quickAckFits(ack)).toBe(true);
    expect(ack).toStartWith('Opening Riverbend');
  });
});

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

describe('quick actions through the route, with no model', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let crewId = '';
  let leadStream: AgentStream | null = null;
  let asked = 0;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const say = async (
    transcript: string,
    surface: 'board' | 'doc' = 'board',
  ): Promise<{ route: string; ack: string; navigate?: string; detail?: string[] }> => {
    const context = surface === 'doc' ? { surface, docId: 'berth-plan' } : { surface };
    const r = await post(`/workspaces/${boardId}/voice`, { transcript, context, author: PERSON });
    expect(r.status).toBe(200);
    return (await r.json()) as { route: string; ack: string; navigate?: string };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-quick-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceComplete: () => {
        asked += 1;
        return Promise.reject(new Error('no model in this test'));
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    boardId = handle.tasks.createWorkspace('Harborlight').id;
    crewId = handle.tasks.createWorkspace('Riverbend Crew').id;
  });

  afterAll(async () => {
    await leadStream?.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('goes to another board by name', async () => {
    asked = 0;
    const r = await say('take me to the Riverbend crew board');
    expect(r.route).toBe('fast-path');
    expect(r.navigate).toBe(`/workspaces/${crewId}`);
    expect(r.ack).toEndWith('Opening Riverbend Crew.');
    expect(asked).toBe(0);
  });

  it('starts a plan or a meeting on the board, and not from a doc', async () => {
    expect((await say('make a plan')).navigate).toBe(`/workspaces/${boardId}?start=plan`);
    expect((await say("let's have a meeting")).navigate).toBe(
      `/workspaces/${boardId}?start=meeting`,
    );
    asked = 0;
    const onDoc = await say('make a plan', 'doc');
    expect(onDoc.navigate).toBeUndefined();
    // Not a start on a doc: the words go on like any other request.
    expect(asked).toBe(1);
  });

  it('says what voice can do, with the examples written under it', async () => {
    const r = await say('what can I do with voice commands');
    expect(r.ack).toEndWith(HELP_SPOKEN);
    expect(r.detail?.length).toBeGreaterThan(2);
  });

  it('saves feedback said in one breath, and asks for it when none was said', async () => {
    const before = handle.docStore.listThreads(BOARD_FEEDBACK_DOC_ID).length;
    const one = await say('feedback: the mic button is hard to find');
    expect(one.ack).toEndWith(FEEDBACK_SAVED_ACK);
    const ask = await say('I want to leave feedback');
    expect(ask.ack).toEndWith(FEEDBACK_ASK);
    const two = await say('the replies are too long');
    expect(two.ack).toEndWith(FEEDBACK_SAVED_ACK);
    const threads = handle.docStore.listThreads(BOARD_FEEDBACK_DOC_ID);
    expect(threads.length).toBe(before + 2);
    const texts = threads.map(
      (t) => handle.docStore.getThread(BOARD_FEEDBACK_DOC_ID, t.id)?.comments[0]?.text,
    );
    expect(texts).toContain('the mic button is hard to find');
    expect(texts).toContain('the replies are too long');
  });

  it('a status question gets the brief with no lead, and goes to a live lead', async () => {
    const brief = await say('what’s occurring status');
    expect(brief.route).toBe('fast-path');
    expect(brief.ack).toContain('Harborlight');
    handle.tasks.attachAgent(boardId, { agentId: 'lead', runtime: 'claude-code-local' });
    leadStream = await openWorkspaceStream(base, boardId, {}, 'lead');
    const lead = await say('what’s occurring status');
    expect(lead.route).toBe('agent');
    expect(lead.ack).toEndWith('On it.');
    expect(handle.tasks.listQueuedVoice(boardId).at(-1)?.transcript).toBe(
      'what’s occurring status',
    );
  });
});
