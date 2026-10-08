/**
 * The voice page (`/voice?agent=<id>`): talk to one agent on the owner's
 * boards, and switch to another with one tap.
 *
 * The talk is the board's own spoken reply (`board/spoken-reply-client.ts`)
 * on the chosen board's converse socket, with the chosen agent named in each
 * `start`. Nothing new records or plays audio. Switching to an agent on the
 * same board changes only the name the next question carries; switching
 * boards opens that board's socket. Either way the server starts a new
 * conversation, and every question until the next switch continues it.
 *
 * An iOS Shortcut's "Open URL" on the Action Button opens this address in
 * the home-screen app, which holds the owner's sign-in.
 */
import type {
  SpokenHeldSetups,
  SpokenSetup,
  SpokenTimingSummary,
} from '@claude-workspaces/core/spoken-reply';
import { fetchJson } from '../board/board-actions.ts';
import { type SpokenReply, createSpokenReply } from '../board/spoken-reply-client.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { mountVoiceConnect } from './voice-connect.ts';
import {
  type VoiceBoardRow,
  type VoicePick,
  pickLine,
  pickSearch,
  startingPick,
} from './voice-page-model.ts';

const LAST_KEY = 'cw.voice-page.last';

function remembered(): { agent?: string; board?: string } | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as { agent?: string; board?: string }) : null;
  } catch {
    return null;
  }
}

function remember(p: VoicePick): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ agent: p.agent.agentId, board: p.board.id }));
  } catch {
    // A private window: the URL still names the pick.
  }
}

/** The boards, or the line that says why there are none to show. */
async function fetchBoards(): Promise<VoiceBoardRow[] | string> {
  try {
    const res = await fetch('/api/voice/agents');
    if (res.status === 401) return 'Sign in to talk to your agents.';
    if (res.status === 403) return 'Only the owner can talk to agents here.';
    if (!res.ok) return 'Your agents could not be loaded. Reload to try again.';
    return ((await res.json()) as { boards?: VoiceBoardRow[] }).boards ?? [];
  } catch {
    return 'Your agents could not be loaded. Reload to try again.';
  }
}

function renderAgents(host: HTMLElement, boards: VoiceBoardRow[], pick: VoicePick | null): void {
  host.replaceChildren();
  for (const b of boards) {
    const group = document.createElement('div');
    group.className = 'voice-board';
    const head = document.createElement('div');
    head.className = 'voice-board-name';
    head.textContent = b.name;
    group.append(head);
    for (const a of b.agents) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'voice-agent';
      row.setAttribute('role', 'radio');
      const on = pick?.board.id === b.id && pick.agent.agentId === a.agentId;
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.dataset.board = b.id;
      row.dataset.agent = a.agentId;
      const mark = document.createElement('span');
      mark.className = 'voice-agent-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✓';
      const name = document.createElement('span');
      name.className = 'voice-agent-name';
      name.textContent = a.lead ? `${a.name} · lead` : a.name;
      const state = document.createElement('span');
      state.className = 'voice-agent-state';
      state.textContent = a.listening ? 'listening' : 'away';
      row.append(mark, name, state);
      group.append(row);
    }
    host.append(group);
  }
}

async function boot(): Promise<void> {
  const line = document.getElementById('voice-line');
  const talk = document.getElementById('voice-talk');
  const list = document.getElementById('voice-agents');
  if (!line || !talk || !list) return;
  const connectSlot = document.getElementById('voice-connect-slot');
  if (connectSlot) {
    void mountVoiceConnect(connectSlot, {
      fetch: (input, init) => fetch(input, init),
      now: Date.now,
      origin: location.origin,
      copy: (text) => navigator.clipboard.writeText(text),
    });
  }
  // The page is the owner's alone, and the server names the speaker from
  // the sign-in, so it never asks for a name.
  const user = await ensureUserIdentity(
    null,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    { suppressNamePrompt: true },
  );
  const author = { id: user.id, name: user.name, kind: user.kind };

  const first = await fetchBoards();
  if (typeof first === 'string') {
    line.textContent = first;
    return;
  }
  let boards = first;
  const params = new URLSearchParams(location.search);
  const start = startingPick(
    boards,
    { agent: params.get('agent'), board: params.get('board') },
    remembered(),
  );
  let pick = start.pick;
  let spoken: SpokenReply | null = null;
  let spokenBoard: string | null = null;
  let generation = 0;

  const say = (text: string): void => {
    line.textContent = text;
  };
  const showPick = (): void => {
    renderAgents(list, boards, pick);
    if (pick) say(pickLine(pick));
  };

  /** The chosen board's socket, opened once per board. */
  const mountSpoken = async (board: string): Promise<void> => {
    if (spokenBoard === board) return;
    spoken?.destroy();
    spoken = null;
    spokenBoard = board;
    const mine = ++generation;
    const base = `/workspaces/${encodeURIComponent(board)}/voice`;
    const r = await fetchJson<{
      setups?: SpokenSetup[];
      held?: SpokenHeldSetups;
      timings?: SpokenTimingSummary;
    }>(`${base}/timings`);
    if (mine !== generation) return;
    if (r === null) {
      // Not this board's verdict: let the next pick ask again.
      spokenBoard = null;
      talk.setAttribute('disabled', '');
      say('Could not load this board’s voice settings. Pick the agent again to retry.');
      return;
    }
    const setups = r.setups ?? [];
    const held = r.held ?? {};
    if (setups.length === 0 && Object.keys(held).length === 0) {
      talk.setAttribute('disabled', '');
      say('Spoken replies are not set up on this server.');
      return;
    }
    talk.removeAttribute('disabled');
    spoken = createSpokenReply({
      document,
      button: talk,
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/converse`,
      setups,
      held,
      timings: r?.timings ?? {},
      author,
      agent: () => pick?.agent.agentId,
      getContext: () => undefined,
      onNavigate: (u) => location.assign(u),
    });
  };

  const choose = (p: VoicePick): void => {
    pick = p;
    remember(p);
    history.replaceState(null, '', `${location.pathname}${pickSearch(p)}`);
    showPick();
    void mountSpoken(p.board.id);
  };

  list.addEventListener('click', (ev) => {
    const row = (ev.target as Element | null)?.closest<HTMLElement>('.voice-agent');
    const board = boards.find((b) => b.id === row?.dataset.board);
    const agent = board?.agents.find((a) => a.agentId === row?.dataset.agent);
    if (board && agent) choose({ board, agent });
  });

  // Who is listening changes while the page sits in a pocket: re-read the
  // list when it is shown again, keeping the pick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void fetchBoards().then((fresh) => {
      if (typeof fresh === 'string') return;
      boards = fresh;
      const keep = pick
        ? startingPick(boards, { agent: pick.agent.agentId, board: pick.board.id }).pick
        : null;
      if (keep) pick = keep;
      showPick();
    });
  });

  if (!pick) {
    talk.setAttribute('disabled', '');
    say('No agent is attached to any of your boards.');
    return;
  }
  choose(pick);
  if (start.missing) {
    say(`${start.missing} is not on any of your boards. ${pickLine(pick)}`);
  }
}

void boot();
