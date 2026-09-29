/**
 * The one block that renders a GRANT item — the allow lines a task asks to
 * add to the owner's Claude Code settings — on every surface that renders one.
 *
 * Built the way `ReviewSecretBlock` is, for its reason: the gate and the
 * controls ship together, so no surface can draw Approve while forgetting who
 * may press it, and no surface can fall through to the verbatim composer. A
 * grant is answered by Approve or Decline and by nothing else; the server
 * refuses a worded answer outright.
 *
 * Every line is shown exactly as it will be written, one per row, in the
 * card's order. Approve sends those same lines back, and the server refuses
 * the approval if they no longer match the card — so what the reader read is
 * what gets written.
 */
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { SecretsGate } from './board-review-model.ts';

export type GrantDecision = 'approve' | 'decline';

function GrantRules(props: { rules: readonly string[] }) {
  return (
    <ul class="board-walk-creds board-grant-rules">
      {props.rules.map((rule) => (
        <li key={rule} class="board-walk-cred">
          <code class="board-walk-cred-service board-grant-rule">{rule}</code>
        </li>
      ))}
    </ul>
  );
}

export function ReviewGrantBlock(props: {
  rules: readonly string[];
  /** The same gate the secret block reads: an owner on the machine the board
   *  runs on. The server also demands that the owner is signed in, and says
   *  so if they are not. */
  gate: SecretsGate;
  onAnswer: (decision: GrantDecision) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  if (props.gate !== 'open') {
    return (
      <Fragment>
        <GrantRules rules={props.rules} />
        <span class="board-walk-question-note">
          {props.gate === 'not-owner'
            ? 'Only the Owner can answer this.'
            : 'This one is answered on the machine the board runs on.'}
        </span>
      </Fragment>
    );
  }
  const press = (decision: GrantDecision): void => {
    if (busy) return;
    setBusy(true);
    void props.onAnswer(decision).finally(() => setBusy(false));
  };
  return (
    <div class="board-walk-answer board-walk-cred-form">
      <GrantRules rules={props.rules} />
      <div class="board-walk-cred-send-row">
        <span class="board-walk-question-note board-grant-note">
          Allowed until this task closes, then removed.
        </span>
        <button
          type="button"
          class="board-btn board-btn-ghost board-walk-cred-send"
          disabled={busy}
          onClick={() => press('decline')}
        >
          Decline
        </button>
        <button
          type="button"
          class="board-btn board-btn-ink board-walk-cred-send"
          disabled={busy}
          onClick={() => press('approve')}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
