/**
 * An agent can leave a board, Bryan can remove one, and neither comes back on
 * the next restart — driven through the REAL server and the MCP child's own
 * restore (`watch-restore.ts`), with nothing between them but HTTP.
 *
 * The restore is what used to undo a removal. It re-wires the watch set the
 * server keeps for an agent and re-attaches to the boards that set names, so
 * a row whose `ws:` key outlived it was back within seconds of every deploy.
 * The other half is the dormant row nobody removed: an agent attached once,
 * not the lead, and has done nothing on the board since — the restore leaves
 * that one alone too, while a lead and an agent that worked there still come
 * back.
 *
 * The registry handed to the restore records what it would wire rather than
 * opening streams; the watch set, the coverage and every attach are the
 * server's own. All names are fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeferredEmitter } from '../../mcp/src/deferred-emit.ts';
import { createHttp } from '../../mcp/src/http-client.ts';
import { handleWorkspaceTool } from '../../mcp/src/tools/workspace.ts';
import type { WatchCoverage } from '../../mcp/src/watch-coverage.ts';
import type { WatchRegistry } from '../../mcp/src/watch-registry.ts';
import { createWatchRestore } from '../../mcp/src/watch-restore.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const LEAD = { id: 'agent-harborlight', name: 'Harborlight' };
const GUEST = { id: 'agent-riverbend', name: 'Riverbend' };
const WORKER = { id: 'agent-saltmarsh', name: 'Saltmarsh' };

let dataDir = '';
let server: ServerHandle;
let base = '';

// Every heartbeat reads stale at once, as each would after a real restart:
// the restore re-attaches only to a board it is not live on.
const boot = () => {
  server = createServer({ port: 0, dataDir, heartbeatFreshMs: 1 });
  base = `http://127.0.0.1:${server.port}`;
};

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** Attach as the MCP does, and record the board's key in the watch set. */
const join_ = async (ws: string, who: { id: string; name: string }) => {
  const a = await call('POST', `/workspaces/${ws}/agents`, {
    agentId: who.id,
    agentName: who.name,
    runtime: 'claude-code-local',
  });
  expect(a.status).toBe(200);
  const w = await call('POST', `/api/agents/${who.id}/watches`, { add: [`ws:${ws}`] });
  expect(w.status).toBe(200);
};

const agentsOn = async (ws: string): Promise<string[]> => {
  const r = await call('GET', `/workspaces/${ws}/agents`);
  return ((r.body.attachments ?? r.body.agents ?? []) as Array<{ agentId: string }>).map(
    (a) => a.agentId,
  );
};

const watchKeys = async (who: { id: string }): Promise<string[]> => {
  const r = await call('GET', `/api/agents/${who.id}/watches`);
  return ((r.body.watches ?? []) as Array<{ key: string }>).map((w) => w.key);
};

/**
 * A respawned session's restore, run as `who`. Returns the boards it wired a
 * board stream for and the boards it POSTed an attachment to.
 */
async function restoreAs(who: { id: string; name: string }) {
  const http = createHttp(() => base);
  const attachPosts: string[] = [];
  const recording = async (method: string, path: string, body?: unknown) => {
    const m = path.match(/^\/workspaces\/([^/]+)\/agents$/);
    if (method === 'POST' && m) attachPosts.push(decodeURIComponent(m[1] ?? ''));
    return http(method, path, body);
  };
  const wired: string[] = [];
  let coverage: WatchCoverage | undefined;
  const watchesPath = `/api/agents/${encodeURIComponent(who.id)}/watches`;
  const registry: WatchRegistry = {
    watchDoc: async (docId) => {
      wired.push(docId);
      return true;
    },
    watchWorkspace: async (workspaceId) => {
      wired.push(`ws:${workspaceId}`);
      return { open: true, persisted: false };
    },
    unwatchDoc: async () => true,
    streamMode: () => 'multiplexed',
    refreshCoverage: async () => coverage,
    coverage: () => coverage,
    setCoverage: (next) => {
      coverage = next;
    },
    watchPersistenceMode: () => 'server',
    lastPersistError: () => undefined,
    watchesPath: () => watchesPath,
  };
  const restore = createWatchRestore({
    http: recording,
    registry,
    watchers: new Map(),
    author: who,
    pluginVersion: '0.0.0-test',
    processId: `respawn-${who.id}`,
    markAttached: () => {},
    notify: async () => {},
    emitChannelMessage: async () => {},
    shouldForward: () => true,
    deferredEmits: createDeferredEmitter((fn) => fn()),
    identityIsShared: false,
  });
  await restore.ensureWatchesRestored();
  expect(restore.state().status).toBe('restored');
  return { wired, attachPosts };
}

/** The `leave_workspace` arm, as the session named `who` would call it. */
async function leave(ws: string, who: { id: string; name: string }) {
  const http = createHttp(() => base);
  const unwatched: string[] = [];
  const detached: string[] = [];
  const res = await handleWorkspaceTool(
    'leave_workspace',
    { workspaceId: ws },
    {
      http,
      ok: (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
      err: (message) => ({ content: [{ type: 'text', text: message }], isError: true }),
      AUTHOR: { ...who, color: '#000000', kind: 'known' },
      PLUGIN_VERSION: '0.0.0-test',
      PROCESS_ID: 'p',
      IDENTITY_IS_SHARED: false,
      markAttached: () => {},
      markDetached: (id) => detached.push(id),
      unwatchDoc: async (key) => {
        unwatched.push(key);
        return true;
      },
      watchWorkspace: async () => ({ open: true, persisted: true }),
    },
  );
  const text = (res?.content[0] as { text: string } | undefined)?.text ?? '';
  return { result: JSON.parse(text) as Record<string, unknown>, unwatched, detached };
}

describe('leaving a board, and removing an agent from one', () => {
  let ws = '';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-agent-leave-'));
    boot();
    const r = await call('POST', '/workspaces', { name: 'Harborlight board' });
    ws = (r.body.workspace as { id: string }).id;
    // The first attach claims the empty seat, so the lead goes first and the
    // guest is attached without it.
    await join_(ws, LEAD);
    await join_(ws, GUEST);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('takes the agent off with the verb, and a restart neither re-attaches nor re-watches it', async () => {
    expect(await agentsOn(ws)).toEqual([LEAD.id, GUEST.id]);
    const left = await leave(ws, GUEST);
    expect(left.result).toMatchObject({ workspaceId: ws, agentId: GUEST.id, detached: true });
    expect(left.detached).toEqual([ws]);
    expect(left.unwatched).toEqual([`ws:${ws}`]);
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
    expect(await watchKeys(GUEST)).toEqual([]);

    const back = await restoreAs(GUEST);
    expect(back).toEqual({ wired: [], attachPosts: [] });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
  });

  it('answers a second leave as already gone, not as a failure', async () => {
    await leave(ws, GUEST);
    const again = await leave(ws, GUEST);
    expect(again.result).toMatchObject({ detached: false });
  });

  it('keeps an agent Bryan removed off the board after its restart', async () => {
    // The board's control is this DELETE, made for somebody else.
    const removed = await call('DELETE', `/workspaces/${ws}/agents/${GUEST.id}`);
    expect(removed).toEqual({ status: 200, body: { ok: true, unwatched: true } });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);

    expect(await restoreAs(GUEST)).toEqual({ wired: [], attachPosts: [] });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
  });

  it('POSITIVE CONTROL: without the removal, the same restore does bring the guest back', async () => {
    // Freshly attached and worked nowhere — but the attach itself is this
    // run's, so make it do something here first, as a working guest would.
    await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title: 'Riverbend checks the ferry timetable', body: 'Fixture.' }],
      author: { ...GUEST, color: '#000000', kind: 'known' },
    });
    const back = await restoreAs(GUEST);
    expect(back.wired).toEqual([`ws:${ws}`]);
    expect(back.attachPosts).toEqual([ws]);
  });

  it('after a server restart, re-attaches the lead and a worker but not a dormant guest', async () => {
    await join_(ws, WORKER);
    const filed = await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title: 'Saltmarsh drafts the tide table', body: 'Fixture.' }],
      author: { ...WORKER, color: '#000000', kind: 'known' },
    });
    expect(filed.status).toBe(200);
    await server.stop();
    boot();

    const guest = await restoreAs(GUEST);
    const worker = await restoreAs(WORKER);
    const lead = await restoreAs(LEAD);
    // The guest's watch still comes back — it asked for the board's events —
    // but its row is not revived.
    expect(guest).toEqual({ wired: [`ws:${ws}`], attachPosts: [] });
    expect(worker.attachPosts).toEqual([ws]);
    expect(lead.attachPosts).toEqual([ws]);
  });
});
