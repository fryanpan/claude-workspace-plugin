/**
 * Home's review section grouped by this week's goals, once the plan lead has
 * tagged any open ask with one (`review-ranks.ts`).
 *
 * Bryan's ask (2026-10-05): decisions tied to the weekly goals, or to an
 * urgent bucket, so that asks from every board sit under the goal they serve.
 * The structure is Team Lead's prototype:
 *
 *  - **Top 10**, the lead's ranked asks in rank order, leaving out the ones
 *    tagged not-this-week or drop;
 *  - **By goal**: urgent, then one section per plan goal in the plan's goal
 *    order, then the untagged asks under one count line ("N new since the
 *    last pass"), then not-this-week and drop folded shut.
 *
 * The two are tabs, as in the prototype, so the projects below stay in view.
 * No per-row badge ("Calm by default"): a Top 10 row names its goal in the
 * plain sub-line, and a section row needs no name at all.
 *
 * Nothing here applies until a tag names something Home can show. With none,
 * `renderReviewBar` draws the bar it always drew. A row opens the review walk
 * at that ask (`/review?item=<key>`), so it is answered where every other ask
 * is.
 */
import { escapeHtml } from '@claude-workspaces/core';
import { DROP_TAG, NOT_THIS_WEEK_TAG, URGENT_TAG } from './review-ranks.ts';

/** How many ranked asks the head of the section shows. */
export const TOP_COUNT = 10;

export interface GoalReviewItem {
  workspaceId: string;
  project: string;
  key?: string;
  /** The question; `title` (the task or doc) when an ask has none. */
  ask?: string;
  title?: string;
  since?: number;
  leadRank?: number;
  goalTag?: string;
}

export interface PlanGoal {
  id: string;
  title: string;
}

export interface GoalSection {
  id: string;
  label: string;
  items: GoalReviewItem[];
  folded: boolean;
}

export interface GoalView {
  top: GoalReviewItem[];
  /** Urgent and the goals, in order. */
  sections: GoalSection[];
  untagged: GoalReviewItem[];
  /** Not this week, then drop. */
  folded: GoalSection[];
}

const FOLDED: ReadonlyArray<[string, string]> = [
  [NOT_THIS_WEEK_TAG, 'Not this week'],
  [DROP_TAG, 'Propose dropping'],
];

/** The tag Home can show for an item: a fixed tag, or a goal the plan still has. */
function tagOf(item: GoalReviewItem, goalIds: ReadonlySet<string>): string | undefined {
  const t = item.goalTag;
  if (!t) return undefined;
  return t === URGENT_TAG || t === NOT_THIS_WEEK_TAG || t === DROP_TAG || goalIds.has(t)
    ? t
    : undefined;
}

/** Whether any item carries a tag Home can show. */
export function hasGoalTags(items: readonly GoalReviewItem[], goals: readonly PlanGoal[]): boolean {
  const ids = new Set(goals.map((g) => g.id));
  return items.some((i) => tagOf(i, ids) !== undefined);
}

/** The items, already in queue order, cut into Home's sections. */
export function goalView(items: readonly GoalReviewItem[], goals: readonly PlanGoal[]): GoalView {
  const ids = new Set(goals.map((g) => g.id));
  const byTag = new Map<string, GoalReviewItem[]>();
  const untagged: GoalReviewItem[] = [];
  for (const item of items) {
    const tag = tagOf(item, ids);
    if (!tag) untagged.push(item);
    else byTag.set(tag, [...(byTag.get(tag) ?? []), item]);
  }
  const section = (id: string, label: string, folded: boolean): GoalSection[] => {
    const list = byTag.get(id) ?? [];
    return list.length > 0 ? [{ id, label, items: list, folded }] : [];
  };
  const shut = new Set([NOT_THIS_WEEK_TAG, DROP_TAG]);
  return {
    top: items
      .filter((i) => i.leadRank !== undefined && !shut.has(tagOf(i, ids) ?? ''))
      .slice(0, TOP_COUNT),
    sections: [
      ...section(URGENT_TAG, 'Urgent', false),
      ...goals.flatMap((g) => section(g.id, g.title, false)),
    ],
    untagged,
    folded: FOLDED.flatMap(([id, label]) => section(id, label, true)),
  };
}

/** "25m", "3h", "2d" — the inbox's spelling. */
function waited(since: number | undefined, now: number): string {
  if (since === undefined) return '';
  const min = Math.max(0, Math.floor((now - since) / 60_000));
  const span =
    min < 60
      ? `${Math.max(1, min)}m`
      : min < 1440
        ? `${Math.floor(min / 60)}h`
        : `${Math.floor(min / 1440)}d`;
  return `waiting ${span}`;
}

function row(item: GoalReviewItem, sub: string[], n?: number): string {
  const href = item.key ? `/review?item=${encodeURIComponent(item.key)}` : '/review';
  const num = n === undefined ? '' : `<span class="goal-n">${n}</span>`;
  return `<a class="goal-row" href="${escapeHtml(href)}">${num}<span class="goal-row-body"><span class="goal-row-title">${escapeHtml(
    item.ask || item.title || '',
  )}</span><span class="goal-row-sub">${sub.filter(Boolean).map(escapeHtml).join(' · ')}</span></span></a>`;
}

function sectionHtml(s: GoalSection, now: number): string {
  const rows = s.items.map((i) => row(i, [i.project, waited(i.since, now)])).join('');
  return `<details class="goal-sec"${s.folded ? '' : ' open'}><summary>${escapeHtml(s.label)} <span class="count">${s.items.length}</span></summary>${rows}</details>`;
}

/** The grouped section. The caller has checked `hasGoalTags`. */
export function renderGoalReview(
  items: readonly GoalReviewItem[],
  goals: readonly PlanGoal[],
  now: number,
): string {
  const view = goalView(items, goals);
  const titleOf = new Map(goals.map((g) => [g.id, g.title]));
  titleOf.set(URGENT_TAG, 'Urgent');
  const top = view.top
    .map(
      (i, n) =>
        `<li>${row(i, [i.project, titleOf.get(i.goalTag ?? '') ?? '', waited(i.since, now)], n + 1)}</li>`,
    )
    .join('');
  const untagged =
    view.untagged.length === 0
      ? ''
      : `<details class="goal-sec goal-new" open><summary>${view.untagged.length} new since the last pass</summary>${view.untagged
          .map((i) => row(i, [i.project, waited(i.since, now)]))
          .join('')}</details>`;
  const byGoal = `${view.sections.map((s) => sectionHtml(s, now)).join('')}${untagged}${view.folded
    .map((s) => sectionHtml(s, now))
    .join('')}`;
  const n = items.length;
  const head = `<div class="allline"><h2 class="alltitle">Review Items for You</h2><a class="allgo" href="/review">Start review ›</a></div><p class="goal-lede">${n} open ${n === 1 ? 'ask' : 'asks'} across every board, placed by Team Lead against this week's goals.</p>`;
  if (view.top.length === 0) {
    return `<div class="allbar goalbar">${head}<div class="goal-view goal-view-only">${byGoal}</div></div>`;
  }
  return `<div class="allbar goalbar">${head}<input type="radio" name="goal-view" id="goal-view-top" class="goal-pick" checked><input type="radio" name="goal-view" id="goal-view-goals" class="goal-pick"><div class="goal-tabs"><label for="goal-view-top">Top ${TOP_COUNT}</label><label for="goal-view-goals">By goal</label></div><div class="goal-view goal-view-top"><ol class="goal-top">${top}</ol></div><div class="goal-view goal-view-goals">${byGoal}</div></div>`;
}

export const LANDING_GOALS_CSS = `
.goalbar .allline{margin:0 0 2px}
.goal-lede{margin:0 0 10px;color:#57606a;font-size:13px}
/* The two views are radio-driven tabs: no script, and the label that is on
   only changes colour, so neither tab moves. */
.goal-pick{position:absolute;opacity:0;pointer-events:none}
.goal-tabs{display:flex;gap:8px;margin:0 0 10px}
.goal-tabs label{border:1px solid #d0d7de;background:#fff;color:#1b1f23;padding:6px 14px;min-height:32px;box-sizing:border-box;display:inline-flex;align-items:center;border-radius:99px;font-size:13px;cursor:pointer}
#goal-view-top:checked ~ .goal-tabs label[for="goal-view-top"],#goal-view-goals:checked ~ .goal-tabs label[for="goal-view-goals"]{border-color:#2e7dd7;color:#2e7dd7}
#goal-view-top:focus-visible ~ .goal-tabs label[for="goal-view-top"],#goal-view-goals:focus-visible ~ .goal-tabs label[for="goal-view-goals"]{outline:2px solid #2e7dd7;outline-offset:1px}
.goal-view-goals{display:none}
#goal-view-goals:checked ~ .goal-view-top{display:none}
#goal-view-goals:checked ~ .goal-view-goals{display:block}
.goal-top{list-style:none;margin:0;padding:0}
.goal-row{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;margin:0 0 6px;background:#fff;border:1px solid #eadfd4;border-radius:8px;color:inherit;min-height:44px;box-sizing:border-box}
.goal-row:hover{text-decoration:none;border-color:#2e7dd7}
.goal-row:focus-visible{outline:2px solid #2e7dd7;outline-offset:1px}
.goal-n{flex-shrink:0;min-width:18px;font-weight:600;color:#8b95a1;font-variant-numeric:tabular-nums}
.goal-row-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.goal-row-title{font-size:14px;font-weight:600;color:#1b1f23;line-height:1.3;overflow-wrap:anywhere}
.goal-row-sub{font-size:12px;color:#57606a}
.goal-sec{margin:0 0 4px}
.goal-sec > summary{font-size:13px;font-weight:600;color:#1b1f23}
`;
