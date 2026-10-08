import type { AnchorContext } from '../types.ts';

/** Is any field of the context set? Used to decide whether to embed one in a new anchor. */
export function hasContext(c: AnchorContext | undefined | null): boolean {
  return !!(c && (c.url || c.view));
}

/**
 * Pin/highlight filter for anchored comments.
 *
 * Rules:
 *   - Anchor has no context (legacy comments from before context was
 *     added): show everywhere. Back-compat.
 *   - Anchor.url present: must equal current.url exactly. `location.pathname`
 *     is included alongside `search + hash`, so SPAs that carry meaningful
 *     state in the query string don't accidentally match each other.
 *   - Anchor.view present: must equal current.view. When the user's UI
 *     is in a different dynamic state, the pin stays hidden until the
 *     host app calls `setContext({ view: …})` back to the original.
 *
 * Off-context threads still appear in the sidebar — they're just not
 * overlaid on the page.
 */
export function contextMatches(
  anchor: AnchorContext | undefined | null,
  current: AnchorContext,
): boolean {
  if (!anchor) return true;
  if (anchor.url && anchor.url !== current.url) return false;
  if (anchor.view && anchor.view !== current.view) return false;
  return true;
}

/**
 * Was the anchor made on this page, in another state of it?
 *
 * The address's path is the page; its query and hash are the state a site
 * keeps its controls in (`?o=ss`, `?all=1`). A thread made with other
 * controls set is still on this page, so the widget pins it, dimmed, rather
 * than dropping it the moment a control moves the address. A `view` the app
 * declared still has to match: the widget cannot put an app back in one.
 */
export function samePage(
  anchor: AnchorContext | undefined | null,
  current: AnchorContext | undefined | null,
): boolean {
  const path = (u?: string) => u?.split(/[?#]/)[0];
  return (
    !!anchor?.url &&
    (!anchor.view || anchor.view === current?.view) &&
    path(anchor.url) === path(current?.url)
  );
}
