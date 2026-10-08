/**
 * The voice conversation API's server side on Workspaces: what a model is,
 * and how a turn reaches one.
 *
 * A model is an agent id. The same agent may sit on several boards; a turn
 * goes to the board where it holds a stream now, else the one it leads,
 * else the first, so a client never has to know boards exist. The turn
 * travels as the converse socket's does (`spoken-reply/agent-conversation.ts`):
 * a row on that agent's addressed comment queue, then a frame on its own
 * streams, and nothing to any other agent. Only that agent's `answer_voice`
 * answers it (`spoken-reply/lead-answer.ts`, keyed on board, row and agent).
 */
import type { AgentLine, AgentVoiceFrame } from '../spoken-reply/agent-conversation.ts';
import { sentAck } from '../spoken-reply/agent-conversation.ts';
import type { LeadAnswers } from '../spoken-reply/lead-answer.ts';
import type { VoiceBoard } from '../voice-agent-list.ts';
import type { VoiceAgents } from './chat.ts';

export interface VoiceBackendDeps {
  /** The owner's live boards and their agents (`voice-agent-list.ts`). */
  boards: () => VoiceBoard[];
  line: AgentLine;
  leads: LeadAnswers;
  newId: () => string;
  now?: () => number;
}

interface Placed {
  board: VoiceBoard;
  agent: VoiceBoard['agents'][number];
}

function place(boards: VoiceBoard[], agentId: string): Placed | null {
  const hits = boards.flatMap((board) =>
    board.agents.filter((a) => a.agentId === agentId).map((agent) => ({ board, agent })),
  );
  return hits.find((h) => h.agent.listening) ?? hits.find((h) => h.agent.lead) ?? hits[0] ?? null;
}

export function workspacesVoiceAgents(d: VoiceBackendDeps): VoiceAgents {
  const now = d.now ?? Date.now;
  return {
    list() {
      const boards = d.boards();
      const seen = new Set<string>();
      const out = [];
      for (const b of boards) {
        for (const a of b.agents) {
          if (seen.has(a.agentId)) continue;
          seen.add(a.agentId);
          const p = place(boards, a.agentId);
          out.push({
            id: a.agentId,
            name: a.name,
            description: `On ${p?.board.name ?? b.name}${p?.agent.listening ? ', listening now' : ''}`,
          });
        }
      }
      return out;
    },

    send(turn, reply) {
      const p = place(d.boards(), turn.agentId);
      if (!p) return { kind: 'unknown' };
      const queueId = d.newId();
      const frame: AgentVoiceFrame = {
        event: 'voice.request',
        workspaceId: p.board.id,
        route: 'agent',
        to: p.agent.agentId,
        transcript: turn.text,
        ack: sentAck(p.agent.name),
        queueId,
        conversationId: turn.conversationId,
        conversation: turn.history.map((h) => ({ ...h })),
        actor: { id: turn.speaker.id, name: turn.speaker.name },
        ts: now(),
      };
      const sent = d.line.deliver(frame);
      if (sent === null) return { kind: 'failed' };
      // The waiter is the turn itself; `from` holds it to this agent.
      d.leads.wait(p.board.id, queueId, frame, (_a, text) => reply(text), p.agent.agentId);
      return { kind: sent > 0 ? 'sent' : 'queued', name: p.agent.name };
    },
  };
}
