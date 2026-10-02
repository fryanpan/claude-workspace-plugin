/**
 * The page's half of the voice review queue: write a decision the server
 * read back and the speaker confirmed, or take one back.
 *
 * The request comes from `spokenDecisionRequest`, the same builder the
 * answer card's declared-item requests use (`reviewReplyRequest`), and goes
 * out under the signed-in person's own identity — so a spoken decision and a
 * tapped one are one request to one route, and leave one record.
 */
import { type SpokenDecide, spokenDecisionRequest } from '@claude-workspaces/core/spoken-reply';
import { api } from '../doc-path.ts';

export type DecideSend = (
  path: string,
  method: string,
  body: unknown,
) => Promise<{ ok: boolean; data: Record<string, unknown> | null }>;

/**
 * Whether the write landed. An answer the server took as a QUESTION
 * (`asked: true`) records nothing, so it is reported as not landed.
 */
export async function writeSpokenDecision(
  d: SpokenDecide,
  deps: { workspaceId: string; author: unknown; send: DecideSend },
): Promise<boolean> {
  const { sub, body } = spokenDecisionRequest(d);
  const res = await deps.send(api(sub, deps.workspaceId), 'POST', {
    ...body,
    author: deps.author,
  });
  return res.ok && res.data?.asked !== true;
}
