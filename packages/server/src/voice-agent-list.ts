/**
 * Who the owner can talk to from the voice page (`/voice`): every agent
 * attached to every live board, grouped by board.
 *
 * The list is what the picker needs and nothing more: a board's id and name,
 * and per agent its id, its display name, whether it holds a stream now, and
 * whether it is that board's lead. No endpoint, runtime, plugin version or
 * heartbeat time, so nothing about the machine an agent runs on. A board the
 * coach is told to skip, or one whose sharing is locked, is listed like any
 * other: those settings govern what leaves the owner's view, and this list is
 * read by the owner alone (`routes/voice-page.ts`).
 */

export interface VoiceAgent {
  agentId: string;
  name: string;
  /** Holding an event stream on this board right now: a turn is heard at
   *  once rather than at its next attach. */
  listening: boolean;
  lead: boolean;
}

export interface VoiceBoard {
  id: string;
  name: string;
  agents: VoiceAgent[];
}

export interface VoiceAgentListSource {
  /** Live boards only: a retired board takes no turns. */
  boards(): ReadonlyArray<{ id: string; name: string; leadAgentId?: string }>;
  attachments(workspaceId: string): ReadonlyArray<{ agentId: string; listening: boolean }>;
  displayName(agentId: string): string | undefined;
}

/** Boards with at least one agent, in the order given; within a board the
 *  lead first, then by name. */
export function voiceAgentList(src: VoiceAgentListSource): VoiceBoard[] {
  const out: VoiceBoard[] = [];
  for (const b of src.boards()) {
    const agents = src
      .attachments(b.id)
      .map((a) => ({
        agentId: a.agentId,
        name: src.displayName(a.agentId) ?? a.agentId,
        listening: a.listening,
        lead: a.agentId === b.leadAgentId,
      }))
      .sort((x, y) => Number(y.lead) - Number(x.lead) || x.name.localeCompare(y.name));
    if (agents.length > 0) out.push({ id: b.id, name: b.name, agents });
  }
  return out;
}
