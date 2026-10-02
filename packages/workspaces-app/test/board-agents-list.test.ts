/**
 * The Settings list of agents attached to a board, and its Remove button.
 *
 * Driven through the real `removeAgent` verb over a stubbed `fetch`, so what
 * is asserted is the request that went out, what the list shows afterwards,
 * and what the reader is told when the server refuses. That the DELETE also
 * keeps the agent off after its restart is the server's half, asserted over
 * HTTP in `packages/server/test/agent-leave-board.test.ts`.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BoardActionDeps, createBoardActions, showToast } from '../src/board/board-actions.ts';
import { renderBoardAgents } from '../src/board/board-agents-list.ts';
import type { PresenceAgent } from '../src/board/board-presence-model.ts';

const WS = 'w-test';
const LEAD = 'agent-harborlight';
const GUEST = 'agent-riverbend';

const agent = (agentId: string): PresenceAgent => ({
  agentId,
  state: 'active',
  stateLabel: 'Active',
  lastToolCallAt: 1,
  listening: false,
});

let sent: Array<{ path: string; method: string }>;
let status: number;

function mount() {
  const state = { agents: [agent(LEAD), agent(GUEST)] } as BoardActionDeps['state'];
  const host = document.getElementById('board-agents-list') as HTMLElement;
  const paint = () =>
    renderBoardAgents(state.agents, {
      host,
      leadAgentId: LEAD,
      remove: (id) => actions.removeAgent(id),
      toast: showToast,
    });
  const actions = createBoardActions({
    workspaceId: WS,
    author: { id: 'u-1', name: 'Alice', kind: 'known', color: '#68a' },
    state,
    renderAll: vi.fn(),
    renderDetail: vi.fn(),
    renderLead: paint,
    focusTitle: vi.fn(),
    location: { assign: vi.fn() },
  } as BoardActionDeps);
  paint();
  return { host, state };
}

const rows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('.board-member')].map((r) => ({
    id: r.dataset.agentId,
    status: r.querySelector('.board-member-role-text')?.textContent,
  }));
const removeButton = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-agent-id="${id}"] button`) as HTMLButtonElement;
const toastText = () => document.getElementById('board-toast')?.textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '<div id="board-toast"></div><div id="board-agents-list"></div>';
  sent = [];
  status = 200;
  vi.stubGlobal('fetch', (path: string, init: { method?: string }) => {
    sent.push({ path, method: init?.method ?? 'GET' });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ ok: status === 200 }),
    } as Response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the agents-on-this-board list', () => {
  it('lists every attached agent and marks the lead', () => {
    const { host } = mount();
    expect(rows(host)).toEqual([
      { id: LEAD, status: 'Lead · Active' },
      { id: GUEST, status: 'Active' },
    ]);
  });

  it('removes an agent with one press: the DELETE goes out and the row leaves', async () => {
    const { host, state } = mount();
    removeButton(host, GUEST).click();
    await vi.waitFor(() => expect(rows(host).map((r) => r.id)).toEqual([LEAD]));
    expect(sent).toEqual([{ path: `/workspaces/${WS}/agents/${GUEST}`, method: 'DELETE' }]);
    expect(state.agents.map((a) => a.agentId)).toEqual([LEAD]);
    expect(toastText()).toBe(`Removed ${GUEST} from this board`);
  });

  it('keeps the row and says so when the server refuses', async () => {
    status = 403;
    const { host } = mount();
    const btn = removeButton(host, GUEST);
    btn.click();
    expect(btn.disabled).toBe(true);
    await vi.waitFor(() => expect(toastText()).toBe(`Could not remove ${GUEST}`));
    expect(rows(host).map((r) => r.id)).toEqual([LEAD, GUEST]);
    expect(btn.disabled).toBe(false);
  });

  it('says so when nobody is attached', () => {
    const host = document.getElementById('board-agents-list') as HTMLElement;
    renderBoardAgents([], { host, leadAgentId: undefined, remove: vi.fn(), toast: vi.fn() });
    expect(host.textContent).toBe('No agents are attached.');
  });
});
