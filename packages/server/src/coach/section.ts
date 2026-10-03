/**
 * "This week" on the front page: Bryan's three goals, and the coach's one
 * open nudge under them.
 *
 * Calm by default (the owner, 2026-09-13): the section is a numbered list
 * and, when there is one, a single plain line with two buttons. No badge,
 * no count, no colour that asks for attention. The buttons are sized for
 * the wider label so neither moves when the other is pressed.
 *
 * With no goals for the week the editor shows open, which is the weekly
 * planning step: the page asks once, in place, and nothing else nags.
 *
 * Only Bryan's own signed-in session gets this HTML (the caller decides).
 * Every string here is his or the coach's, and all of it is escaped.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { CoachGoalList, CoachNudge, CoachPassRecord } from './types.ts';
import { MAX_GOALS, MAX_GOAL_CHARS } from './types.ts';

export interface CoachSectionInput {
  goals: CoachGoalList | null;
  nudge: CoachNudge | null;
  lastPass: CoachPassRecord | undefined;
}

const clockText = (at: number): string =>
  new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

function editor(goals: readonly string[], open: boolean): string {
  const inputs = Array.from({ length: MAX_GOALS }, (_, i) => {
    const v = goals[i] ?? '';
    return `<label class="coach-field"><span class="coach-num">${i + 1}</span><input type="text" name="goal" maxlength="${MAX_GOAL_CHARS}" value="${escapeHtml(v)}" aria-label="Goal ${i + 1}"${i === 0 ? ' placeholder="The most important thing this week"' : ''}></label>`;
  }).join('');
  return `<form class="coach-edit" data-coach-edit${open ? '' : ' hidden'}>${inputs}<div class="coach-acts"><button type="submit" class="board-btn board-btn-ink">Save goals</button>${
    goals.length > 0
      ? '<button type="button" class="board-btn" data-act="cancel">Cancel</button>'
      : ''
  }</div></form>`;
}

function nudgeLine(n: CoachNudge): string {
  return `<div class="coach-nudge" data-nudge="${escapeHtml(n.id)}"><p class="coach-q">${escapeHtml(n.question)}</p><p class="coach-sub">${escapeHtml(n.drift)} · goal ${n.goalIndex + 1} · <time data-at="${n.at}" data-clock>${escapeHtml(clockText(n.at))}</time></p><div class="coach-acts"><button type="button" class="board-btn" data-answer="back-to-it">Back to it</button><button type="button" class="board-btn" data-answer="plans-changed">Plans changed</button></div></div>`;
}

export function renderCoachSection(input: CoachSectionInput): string {
  const goals = input.goals?.goals ?? [];
  const pass = input.lastPass
    ? `Checked at <time data-at="${input.lastPass.at}" data-clock>${escapeHtml(clockText(input.lastPass.at))}</time>`
    : 'Not checked yet';
  const list =
    goals.length === 0
      ? '<p class="coach-quiet">Set up to 3 goals for this week, most important first.</p>'
      : `<ol class="coach-goals">${goals.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ol>`;
  const edit =
    goals.length === 0
      ? ''
      : '<button type="button" class="board-linklike" data-act="edit">Edit</button>';
  return `<section id="coach" class="coach-front" aria-labelledby="coach-h"><div class="coach-head"><h2 id="coach-h">This week</h2><span class="coach-pass">${pass}</span>${edit}</div>${list}${
    input.nudge ? nudgeLine(input.nudge) : ''
  }${editor(goals, goals.length === 0)}</section>`;
}

/** The section's styles, in the front page's own palette (`LANDING_CSS`). */
export const COACH_SECTION_CSS = `
.coach-front{--border:#e6e9ed;--fg:#1b1f23;--fg-muted:#6e7781;--bg-panel:#fff;--bg-hover:#f8f9fb;--radius:8px;margin:0 0 22px}
.coach-head{display:flex;align-items:center;gap:4px 12px;min-height:36px;margin:0 0 4px}
.coach-head h2{flex:1 1 auto;margin:0}
.coach-pass{font-size:12.5px;color:var(--fg-muted)}
.coach-goals{margin:0;padding:0 0 0 1.6em}
.coach-goals li{padding:4px 0;line-height:1.4}
.coach-quiet{margin:0;padding:6px 0;font-size:14px;color:var(--fg-muted)}
.coach-nudge{margin:10px 0 0;padding:10px 0 0;border-top:1px solid var(--border)}
.coach-q{margin:0;line-height:1.4}
.coach-sub{margin:2px 0 8px;font-size:12.5px;line-height:1.4;color:var(--fg-muted)}
.coach-acts{display:flex;flex-wrap:wrap;gap:8px}
.coach-front .board-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;min-width:132px;padding:4px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-panel);color:var(--fg);font:inherit;font-size:14px;cursor:pointer}
.coach-front .board-btn:hover{background:var(--bg-hover)}
.coach-front .board-btn-ink{background:var(--fg);border-color:var(--fg);color:var(--bg-panel)}
.coach-front .board-btn:disabled{opacity:.6;cursor:default}
.coach-front .board-linklike{min-height:36px;padding:0;border:none;background:none;font:inherit;font-size:13px;color:var(--fg-muted);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.coach-edit{margin:8px 0 0}
.coach-edit[hidden]{display:none}
.coach-field{display:flex;align-items:center;gap:8px;margin:0 0 6px}
.coach-num{width:1.2em;text-align:right;color:var(--fg-muted)}
.coach-field input{flex:1 1 auto;min-width:0;min-height:36px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font:inherit;font-size:14px}
.coach-edit .coach-acts{padding-left:calc(1.2em + 8px)}
`;
