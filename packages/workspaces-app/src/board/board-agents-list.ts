/**
 * The Settings subsection that lists the agents attached to this board, each
 * with a way to take it off (Bryan's task, 2026-10-01: "a board holds only
 * the agents he wants on it").
 *
 * Every attachment is listed, not only the agents listening now: the row an
 * unwanted agent leaves behind is exactly the one with nobody behind it.
 *
 * Remove is `DELETE /workspaces/<id>/agents/<agentId>`. The server drops the
 * attachment AND the board's key from that agent's watch set, which is what
 * keeps its next restart from re-attaching it. No dialog: the agent comes
 * back the moment it attaches again, so the act is not one that needs a
 * second question. The route is trusted-local and refuses a share visitor;
 * the button is drawn for everybody, as the lead selector above it is, and a
 * refusal is reported rather than hidden.
 */
import type { PresenceAgent } from './board-presence-model.ts';

export interface BoardAgentsListDeps {
  /** The list's own container. */
  host: HTMLElement;
  /** The board's lead, marked on its row. */
  leadAgentId: string | undefined;
  /** Take one agent off, repainting on success. Resolves whether the server
   *  agreed. */
  remove(agentId: string): Promise<boolean>;
  toast(message: string): void;
}

/** Paint the list. Called on every attachments read, so it is idempotent. */
export function renderBoardAgents(agents: PresenceAgent[], deps: BoardAgentsListDeps): void {
  const { host } = deps;
  const doc = host.ownerDocument;
  host.replaceChildren();
  if (agents.length === 0) {
    const none = doc.createElement('p');
    none.className = 'board-settings-note';
    none.textContent = 'No agents are attached.';
    host.append(none);
    return;
  }
  const sorted = [...agents].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const agent of sorted) {
    const row = doc.createElement('div');
    row.className = 'board-member';
    row.dataset.agentId = agent.agentId;
    const who = doc.createElement('span');
    who.className = 'board-member-who';
    who.textContent = agent.agentId;
    const status = doc.createElement('span');
    status.className = 'board-member-role-text';
    status.textContent =
      agent.agentId === deps.leadAgentId ? `Lead · ${agent.stateLabel}` : agent.stateLabel;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'board-btn';
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', `Remove ${agent.agentId} from this board`);
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void deps.remove(agent.agentId).then((ok) => {
        if (!ok) {
          btn.disabled = false;
          deps.toast(`Could not remove ${agent.agentId}`);
          return;
        }
        deps.toast(`Removed ${agent.agentId} from this board`);
      });
    });
    row.append(who, status, btn);
    host.append(row);
  }
}
