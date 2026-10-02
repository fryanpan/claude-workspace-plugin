/**
 * Incoming Messages' styles, inlined into the front page beside the review
 * bar's. The front page keeps its own inline stylesheet and palette (no app
 * tokens, no app CSS bundle), so the section names that palette once and
 * borrows the board's review-row anatomy under the same class names, scoped
 * to `.inbox-front` so nothing leaks into the rest of the page.
 *
 * From the round-3 mock, less the reply box, the reply-by menus and the
 * struck-through sent line: those arrive with Send.
 */
export const INBOX_SECTION_CSS = `
.inbox-front{--accent:#2e7dd7;--border:#e6e9ed;--fg:#1b1f23;--fg-muted:#6e7781;--bg-panel:#fff;--bg-subtle:#f6f8fa;--bg-hover:#f8f9fb;--radius:8px;--radius-lg:10px;margin:0 0 22px}
.inbox-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;margin:0 0 4px;min-height:36px}
.inbox-head h2{flex:1 1 auto;margin:0}
.inbox-pass{font-size:12.5px;color:var(--fg-muted)}
.inbox-front .board-review-row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-height:44px;padding:10px 8px;border:none;border-radius:0;background:none;font:inherit;text-align:left;color:inherit;cursor:pointer}
.inbox-front .board-review-row:hover{background:var(--bg-hover)}
.inbox-front .board-review-row-title{font-weight:500;line-height:1.35;color:var(--fg);overflow-wrap:anywhere}
.inbox-front .board-review-row-sub{font-size:12.5px;line-height:1.4;color:var(--fg-muted)}
.inbox-front .board-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;min-width:112px;padding:4px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-panel);color:var(--fg);font:inherit;font-size:14px;cursor:pointer}
.inbox-front .board-btn:hover{background:var(--bg-hover);text-decoration:none}
.inbox-front .board-linklike{min-height:36px;padding:0;border:none;background:none;font:inherit;font-size:13px;color:var(--fg-muted);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.inbox-front .board-home-quiet{margin:0;padding:10px 0;font-size:14px;color:var(--fg-muted)}
.inbox-row{border-top:1px solid var(--border);scroll-margin-top:12px}
.inbox-row[hidden]{display:none}
/* The line holds the swipe: the row slides over a snooze strip beneath it. */
.inbox-line{display:flex;align-items:center;gap:8px;position:relative;overflow:hidden;touch-action:pan-y}
.inbox-line>.board-review-row{flex:1 1 auto;min-width:0;position:relative;z-index:1;background:var(--bg-panel);transition:transform .15s ease}
.inbox-swiping .board-review-row{transition:none}
.inbox-line-acts{display:flex;gap:6px;flex:none;padding-right:6px}
.inbox-swipe-under{position:absolute;inset:0;display:none;align-items:center;gap:6px;padding-left:18px;color:var(--fg-muted);background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:var(--radius-lg)}
.inbox-swiping .inbox-swipe-under{display:flex}
.inbox-swipe-armed .inbox-swipe-under{color:var(--fg);background:color-mix(in srgb,var(--accent) 30%,transparent)}
/* With a mouse the clock shows on hover or focus; it always holds its space. */
.inbox-snooze-btn{width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:var(--radius-lg);background:none;color:var(--fg-muted);cursor:pointer;opacity:0}
.inbox-snooze-btn .inbox-icon{width:18px;height:18px}
.inbox-line:hover .inbox-snooze-btn,.inbox-snooze-btn:focus-visible,.inbox-snooze-btn[aria-expanded="true"]{opacity:1}
.inbox-snooze-btn:hover{background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--fg)}
@media (hover:none){.inbox-line-acts{display:none}}
.inbox-row-cursor{box-shadow:inset 3px 0 0 var(--accent)}
.inbox-row-open{background:color-mix(in srgb,var(--accent) 9%,transparent);border-radius:var(--radius-lg)}
.inbox-where{display:inline-flex;align-items:center;gap:4px;vertical-align:-2px}
.inbox-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}
.inbox-card{padding:0 8px 12px}
.inbox-msg{margin:0 0 10px;padding:10px 12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.inbox-actions{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.inbox-hint{font-size:12.5px;color:var(--fg-muted)}
.inbox-more,.inbox-snoozed-line{display:block;width:100%;min-height:40px;padding:10px 8px;border:none;border-top:1px solid var(--border);background:none;text-align:left;font:inherit;font-size:13px;color:var(--fg-muted);cursor:pointer}
.inbox-more{color:var(--accent)}
.inbox-undo{align-self:flex-start;min-height:32px;padding:0;border:none;background:none;color:var(--accent);font:inherit;font-size:12.5px;cursor:pointer}
.inbox-keys{margin:0 0 8px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-subtle);font-size:13px}
.inbox-keys[hidden],.inbox-snoozed[hidden]{display:none}
.inbox-keys dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0 0 4px}
.inbox-keys dt{font-family:ui-monospace,monospace}
.inbox-keys dd,.inbox-keys p{margin:0}
.inbox-foot{display:flex;align-items:center;gap:12px;padding-top:8px;border-top:1px solid var(--border)}
.inbox-count{margin-right:auto}
/* Gmail's snooze picker: a modal over the page, whichever way it was asked for. */
.inbox-modal-back{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,#000 35%,transparent)}
.inbox-modal{width:min(320px,100%);padding:8px 0;border-radius:var(--radius-lg);background:var(--bg-panel);color:var(--fg);box-shadow:0 8px 28px color-mix(in srgb,#000 30%,transparent)}
.inbox-modal-title{padding:10px 20px 8px;font-weight:600}
.inbox-modal-opt{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 20px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.inbox-modal-opt:hover,.inbox-modal-opt:focus-visible{background:var(--bg-hover)}
.inbox-modal-opt[hidden],.inbox-modal-pick[hidden]{display:none}
.inbox-modal-when{margin-left:auto;color:var(--fg-muted);font-size:13px}
.inbox-modal-rule{height:1px;margin:6px 0;background:var(--border)}
.inbox-modal-pick{display:flex;gap:8px;padding:6px 20px 10px}
.inbox-modal-pick input{flex:1 1 auto;min-width:0;font:inherit}
.inbox-modal-pick .board-btn{min-width:0}
.inbox-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:8px;background:#1b1f23;color:#fff;font-size:13px;z-index:60}
.inbox-toast[hidden]{display:none}
.inbox-toast button{min-height:32px;padding:0;border:none;background:none;color:#9cc7f5;font:inherit;font-weight:600;cursor:pointer}
`;
