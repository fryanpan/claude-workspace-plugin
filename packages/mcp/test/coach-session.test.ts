/**
 * The coach session's half: each frame reads as one line naming what the
 * owner did, and `coach_moment` posts a moment, handing back the server's
 * refusal as an answer the session can read.
 */
import { describe, expect, it } from 'vitest';
import { coachLine } from '../src/coach-line.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

describe('coachLine', () => {
  it('names what the owner did, where, and carries their words', () => {
    const line =
      coachLine(
        'coach.event',
        {
          at: Date.UTC(2026, 9, 7, 17, 5),
          kind: 'wrote',
          boardId: 'w-1',
          board: 'Harborlight',
          docId: 'd-1',
          doc: 'Launch post',
          heading: 'Pricing',
          text: 'We should build the importer first.',
        },
        'America/Los_Angeles',
      ) ?? '';
    expect(line).toBe(
      '[coach.event 10:05] The owner wrote, in "Launch post" on board "Harborlight", under "Pricing".\nWe should build the importer first.',
    );
    expect(coachLine('coach.event', { kind: 'left', boardId: 'w-1', board: 'Riverbend' })).toBe(
      '[coach.event] The owner left the page of board "Riverbend".',
    );
  });

  it('reads a digest as one line per stay or thing done, with the words he wrote', () => {
    const t = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
    const line = coachLine(
      'coach.digest',
      {
        from: t(17, 0),
        to: t(17, 15),
        items: [
          {
            kind: 'view',
            at: t(17, 0),
            minutes: 12,
            boardId: 'w-1',
            board: 'Harborlight',
            docId: 'd-2',
            doc: 'Button hover mock',
            headings: ['Hover', 'Focus'],
          },
          {
            kind: 'comment',
            at: t(17, 12),
            boardId: 'w-1',
            board: 'Harborlight',
            docId: 'd-2',
            doc: 'Button hover mock',
            text: 'Softer shadow?\nAnd a 2px lift.',
          },
          { kind: 'left', at: t(17, 14), boardId: 'w-1', board: 'Harborlight' },
        ],
      },
      'America/Los_Angeles',
    );
    expect(line).toBe(
      [
        '[coach.digest 10:00–10:15] What the owner did:',
        '- 10:00, 12 min: read "Button hover mock" on board "Harborlight" ("Hover", "Focus")',
        '- 10:12: commented on "Button hover mock" on board "Harborlight"',
        '  Softer shadow?',
        '  And a 2px lift.',
        '- 10:14: left the page of board "Harborlight"',
      ].join('\n'),
    );
    expect(coachLine('coach.digest', { items: [{ kind: 'danced', boardId: 'w-1' }] })).toBeNull();
  });

  it('reads an answer and a preference as things to remember', () => {
    expect(
      coachLine('coach.answer', {
        momentId: 'cm-aaaaaaaaaaaa',
        answer: 'not-now',
        goal: 'Ask why first',
        line: "Hi, I'm noticing you're designing the fix. Why first?",
      }),
    ).toContain('answered "Not now": right goal, wrong time');
    expect(coachLine('coach.preference', { readiness: 'less' })).toContain('less readily');
  });

  it('says nothing for a frame it cannot read', () => {
    expect(coachLine('coach.event', { kind: 'danced', boardId: 'w-1' })).toBeNull();
    expect(coachLine('coach.answer', { answer: 'thanks' })).toBeNull();
    expect(coachLine('coach.preference', { readiness: 'loud' })).toBeNull();
  });
});

function ctxFor(answer: (path: string) => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer(path);
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  };
  return { calls, ctx: ctx as never };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

const MOMENT = {
  goal: 1,
  matched: 'I start on a solution',
  observed: 'Designing the importer before saying why',
  line: "Hi, I'm noticing you're designing the importer. What is it for?",
};

describe('coach_moment', () => {
  it('posts the moment and returns its id', async () => {
    const { calls, ctx } = ctxFor(() => ({ id: 'cm-aaaaaaaaaaaa' }));
    const r = await handleWorkspaceTool('coach_moment', MOMENT, ctx);
    expect(calls).toEqual([['POST', '/coach/moments', MOMENT]]);
    expect(JSON.parse(text(r))).toEqual({ raised: true, id: 'cm-aaaaaaaaaaaa' });
  });

  it('hands back a refusal with its reason, and throws anything else', async () => {
    const refused = ctxFor(() => {
      throw new Error(
        'POST /coach/moments → 409: {"error":"moment-open","message":"A moment is already on his page."}',
      );
    });
    const r = await handleWorkspaceTool('coach_moment', MOMENT, refused.ctx);
    expect(JSON.parse(text(r))).toMatchObject({ raised: false, reason: 'moment-open' });
    const broken = ctxFor(() => {
      throw new Error('POST /coach/moments → 500: boom');
    });
    await expect(handleWorkspaceTool('coach_moment', MOMENT, broken.ctx)).rejects.toThrow('500');
  });
});
