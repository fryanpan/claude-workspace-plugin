/**
 * Ask the server which spoken setups it runs, and mount the planning voice's
 * card (`doc-interview.ts`) only when it names one (or holds one, so choosing
 * it can say why). Kept apart from the card so the card's module is its
 * state machine alone.
 */
import type { SpokenHeldSetups, SpokenSetup } from '@claude-workspaces/core/spoken-reply';
import type { MountScope } from '../mount-scope.ts';
import { type DocInterviewOpts, mountDocInterview } from './doc-interview.ts';

export function wireDocInterview(opts: {
  docId: string;
  workspaceId: string;
  user: { id: string; name: string; kind?: string };
  scope: MountScope;
  meeting?: DocInterviewOpts['meeting'];
}): void {
  const base = `/workspaces/${encodeURIComponent(opts.workspaceId)}/voice`;
  void fetch(`${base}/timings`)
    .then((r) =>
      r.ok ? (r.json() as Promise<{ setups?: SpokenSetup[]; held?: SpokenHeldSetups }>) : null,
    )
    .catch(() => null)
    .then((r) => {
      const setups = r?.setups ?? [];
      const held = r?.held ?? {};
      if (opts.scope.disposed || (setups.length === 0 && Object.keys(held).length === 0)) return;
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      mountDocInterview({
        docId: opts.docId,
        workspaceId: opts.workspaceId,
        author: {
          id: opts.user.id,
          name: opts.user.name,
          ...(opts.user.kind ? { kind: opts.user.kind } : {}),
        },
        scope: opts.scope,
        setups,
        held,
        url: `${wsProto}://${location.host}${base}/converse`,
        ...(opts.meeting ? { meeting: opts.meeting } : {}),
      });
    });
}
