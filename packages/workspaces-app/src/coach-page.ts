/**
 * The coach's card on a page that holds a frame it cannot draw into: a mock,
 * an HTML attachment or a dev server, each shown sandboxed inside the host
 * page (`mockup-frame.ts` on the server). The host loads this with the board
 * and doc it is showing, and the card sits over the frame. The card stops
 * itself for anyone but the owner, and the host never loads it for a share
 * visitor.
 */
import { mountCoachCard } from './coach-card.ts';

const tag = document.querySelector<HTMLScriptElement>('script[data-coach-page]');
const workspaceId = tag?.dataset.workspaceId;
const docId = tag?.dataset.docId;
if (workspaceId) mountCoachCard({ workspaceId, ...(docId ? { docId } : {}) });
