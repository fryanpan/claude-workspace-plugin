/**
 * The grant door, driven directly — for the refusals a request through the
 * real admission gate cannot reach.
 *
 * `task-grants-door.test.ts` drives a real server, which is the right shape
 * for everything a caller can send. Two of the door's checks sit behind
 * something that already refuses there: the workspace-scope middleware 404s a
 * task from another board before the door runs, and no reachable state makes
 * the store refuse an answer the door has already checked. Both checks exist
 * so that the door does not depend on that, so each is exercised here with
 * the smallest context that reaches it, and each case pairs with a control
 * that differs in one field.
 *
 * Placeholders throughout; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem, User } from '@claude-workspaces/core';
import type { IdentityRecord } from '../src/identities.ts';
import { handleTaskGrants } from '../src/routes/task-grants.ts';
import type { TaskRouteRequest, TaskRoutesContext } from '../src/routes/task-routes-context.ts';

const AGENT: User = { id: 'a-riverbend', name: 'Release Builder', kind: 'known', color: '#888888' };
const OWNER: IdentityRecord = {
  id: 'known-bryan',
  kind: 'person',
  displayName: 'Owner',
  color: '#336699',
  status: 'active',
} as unknown as IdentityRecord;
const BOARD = 'w-harbor';
const TASK = 't-release';
const ITEM = 'r-grant';
const RULES = ['Bash(git push --force-with-lease:*)'];
const ORIGIN = 'https://workspaces.harborlight.test';

const ITEM_ROW = {
  id: ITEM,
  review: { shape: 'grant', headline: 'Allow the push', allowRules: RULES, ownerOnly: true },
  createdAt: 1_700_000_000_000,
  createdBy: AGENT,
} as unknown as TaskReviewItem;

interface Driven {
  status: number;
  body: Record<string, unknown>;
  granted: number;
  answered: number;
}

async function drive(opts: {
  taskBoard?: string;
  refusal?: { ok: false; error: string; message?: string };
}): Promise<Driven> {
  let granted = 0;
  let answered = 0;
  const task = { id: TASK, workspaceId: opts.taskBoard ?? BOARD, status: 'in_progress' };
  const ctx = {
    taskStore: {
      getTask: () => task,
      listReviewItems: () => [ITEM_ROW],
      answerTaskReviewRefusal: () => opts.refusal,
      answerTaskReview: () => {
        answered++;
        return opts.refusal ?? { ok: true, task, item: ITEM_ROW };
      },
      emit: () => undefined,
    },
    taskProjection: { refreshTask: () => undefined },
    j: (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    safeJson: async (req: Request) => (await req.json()) as Record<string, unknown>,
    permissionGrants: {
      grant: () => {
        granted++;
        return { ok: true, added: RULES, alreadyAllowed: [] };
      },
    },
  } as unknown as TaskRoutesContext;
  const rq = {
    req: new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ decision: 'approve', allowRules: RULES }),
    }),
    scope: { workspaceId: BOARD, rest: `tasks/${TASK}/review-items/${ITEM}/grant` },
    requireOwner: () => null,
    roleFor: () => 'owner',
    provenIdentityFor: () => OWNER,
    requestOriginFor: () => ORIGIN,
  } as unknown as TaskRouteRequest;
  const res = await handleTaskGrants(ctx, rq);
  if (!res) throw new Error('the door did not claim its own path');
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    granted,
    answered,
  };
}

describe('the grant door, past the admission gate', () => {
  it('CONTROL: a card on the path’s own board is approved and written', async () => {
    const d = await drive({});
    expect(d.status).toBe(200);
    expect(d.granted).toBe(1);
    expect(d.answered).toBe(1);
  });

  it('404s a task that is on another board, and writes nothing', async () => {
    const d = await drive({ taskBoard: 'w-salt' });
    expect(d.status).toBe(404);
    expect(d.granted).toBe(0);
  });

  it('asks the store before writing the settings, so a refused answer writes nothing', async () => {
    const d = await drive({
      refusal: { ok: false, error: 'not-a-person', message: 'only a person answers this' },
    });
    expect(d.status).toBe(400);
    expect(d.body.error).toBe('not-a-person');
    expect(d.granted).toBe(0);
    expect(d.answered).toBe(0);
  });
});
