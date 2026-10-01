/**
 * The stall tick reads every builder's worktree without holding the loop.
 *
 * Prod logged `[loop] blocked 1100–1900ms — nothing in flight` every ten
 * minutes, with CPU a third to a tenth of the wall time. The ten-minute timer
 * was the stall tick, and the wait was git: the UI gate asks each open
 * dispatch's worktree what it changed, about a dozen `spawnSync` git
 * processes apiece, inside the synchronous snapshot. A local reproduction
 * with four dispatches held the loop 1.85–1.96s per tick on 40–50ms of CPU.
 *
 * The timer's pass now reads the worktrees in `prepare`, each git process
 * awaited, and the snapshot reads that map. What this file asserts is the
 * behaviour, not a duration: other work on the loop gets turns WHILE the pass
 * runs — one per awaited git process at least — and the finding the lead is
 * told is the one the synchronous read produced.
 *
 * Mutation control: making `prepare` skip `readChangedWork`, so the snapshot
 * falls back to the synchronous read, fails the turn count with 0 turns. With
 * the fix the count is above 100,000: the counter re-arms on `setImmediate`,
 * so it spins for as long as the pass is waiting on a git process.
 *
 * Every fixture is invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { type BuilderWorktree, makeBuilderWorktree } from './builder-worktree-fixture.ts';
import { type Frame, listenFrames } from './doc-activity-stall-harness.ts';
import { FILER, LEAD } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/** What a builder restyling the board has written. */
const UI_WORK = { 'packages/workspaces-app/src/board.css': '.task-card { padding: 8px; }\n' };

/**
 * The fewest loop turns the timed pass may give other work. One worktree is
 * read with about a dozen git processes, each a separate await, so the loop
 * turns at least once per process; half that is the floor, and the
 * synchronous read allows zero.
 */
const MIN_TURNS = 6;

describe('the timed stall pass and the builders’ worktrees', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wt: BuilderWorktree | undefined;
  const streams: Array<ReturnType<typeof listenFrames>> = [];

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-git-yields-'));
    handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await handle.stop();
    wt?.cleanup();
    wt = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with one row the FILER agent filed, took, and is building in a
   *  checkout that touches a stylesheet; and the lead listening. */
  async function boardWithUiDispatch(): Promise<{ taskId: string; lead: { frames: Frame[] } }> {
    const { workspace } = await post<{ workspace: { id: string } }>('/workspaces', {
      name: 'harborlight',
      leadAgentId: LEAD.id,
    });
    await post(`/workspaces/${workspace.id}/agents`, {
      agentId: FILER.id,
      runtime: 'claude-code-local',
    });
    const { task } = await post<{ task: { id: string; status: string } }>(
      `/workspaces/${workspace.id}/tasks`,
      {
        title: 'Agent can see why a task is blocked',
        body: 'Show the reason on the card so nobody has to open the row.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      },
    );
    for (const to of task.status === 'todo' ? ['in-progress'] : ['todo', 'in-progress']) {
      await post(`/workspaces/${workspace.id}/tasks/${task.id}/transition`, {
        to,
        author: FILER,
      });
    }
    wt = makeBuilderWorktree();
    await post(`/workspaces/${workspace.id}/dispatches`, {
      taskId: task.id,
      worktreePath: wt.path,
    });
    wt.edit(UI_WORK);
    await post(`/workspaces/${workspace.id}/agents`, {
      agentId: LEAD.id,
      runtime: 'claude-code-local',
    });
    const res = await fetch(
      `${base}/workspaces/${workspace.id}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const lead = listenFrames(res);
    streams.push(lead);
    return { taskId: task.id, lead };
  }

  const ungatedOf = (frame: Frame | undefined) =>
    (frame?.data?.ungatedUi ?? []) as Array<Record<string, unknown>>;

  it('gives the loop back between git reads, and still names the ungated row', async () => {
    const { taskId, lead } = await boardWithUiDispatch();

    // Another task on the loop, re-arming itself until the pass ends. It runs
    // once per loop turn, so it counts the turns the pass handed back.
    let turns = 0;
    let running = true;
    const spin = () => {
      if (!running) return;
      turns++;
      setImmediate(spin);
    };
    const pass = handle.nudgeStallsTimed();
    setImmediate(spin);
    await pass;
    running = false;

    expect(turns).toBeGreaterThanOrEqual(MIN_TURNS);
    const told = await waitFor(
      () => lead.frames.find((f) => f.event === STALL_EVENT && ungatedOf(f).length > 0),
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the ungated row' },
    );
    expect(ungatedOf(told)[0]).toMatchObject({
      id: taskId,
      file: 'packages/workspaces-app/src/board.css',
      from: 'dispatch',
    });
  }, 30_000);
});
