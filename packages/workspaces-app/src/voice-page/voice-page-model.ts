/**
 * Which agent the voice page (`/voice`) starts on, and what it says about it.
 * Pure, so the choice is testable without a page.
 */

export interface VoiceAgentRow {
  agentId: string;
  name: string;
  listening: boolean;
  lead: boolean;
}

export interface VoiceBoardRow {
  id: string;
  name: string;
  agents: VoiceAgentRow[];
}

export interface VoicePick {
  board: VoiceBoardRow;
  agent: VoiceAgentRow;
}

/** One agent can sit on several boards: the URL's board wins, then a board
 *  where it is listening now, then one it leads, then the first. */
function findAgent(boards: VoiceBoardRow[], agentId: string, boardId?: string): VoicePick | null {
  const hits = boards.flatMap((board) =>
    board.agents.filter((a) => a.agentId === agentId).map((agent) => ({ board, agent })),
  );
  return (
    hits.find((h) => h.board.id === boardId) ??
    hits.find((h) => h.agent.listening) ??
    hits.find((h) => h.agent.lead) ??
    hits[0] ??
    null
  );
}

/**
 * The agent to start on: the URL's, else the one this browser last talked
 * to, else the first board's lead. `missing` is the URL's agent when no
 * board has it, so the page can say so rather than silently pick another.
 */
export function startingPick(
  boards: VoiceBoardRow[],
  want: { agent?: string | null; board?: string | null },
  remembered?: { agent?: string; board?: string } | null,
): { pick: VoicePick | null; missing?: string } {
  if (want.agent) {
    const hit = findAgent(boards, want.agent, want.board ?? undefined);
    if (hit) return { pick: hit };
    return { pick: fallback(boards, remembered), missing: want.agent };
  }
  return { pick: fallback(boards, remembered) };
}

function fallback(
  boards: VoiceBoardRow[],
  remembered?: { agent?: string; board?: string } | null,
): VoicePick | null {
  if (remembered?.agent) {
    const hit = findAgent(boards, remembered.agent, remembered.board);
    if (hit) return hit;
  }
  const board = boards[0];
  const agent = board?.agents[0];
  return board && agent ? { board, agent } : null;
}

/** The line under the picker: who the next question goes to. */
export function pickLine(p: VoicePick): string {
  const where = p.agent.listening ? 'listening now' : 'away — it hears you when it is back';
  return `Talking to ${p.agent.name} on ${p.board.name} · ${where}`;
}

/** The page's own address for a pick, so a reload or a Shortcut lands there. */
export function pickSearch(p: VoicePick): string {
  const q = new URLSearchParams({ agent: p.agent.agentId, board: p.board.id });
  return `?${q.toString()}`;
}
