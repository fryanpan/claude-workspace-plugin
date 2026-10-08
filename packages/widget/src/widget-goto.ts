/**
 * Going to the page state a thread was made in.
 *
 * A site that keeps its controls in the address (`?o=ss`, `?all=1`) has a
 * state per address, and a thread made in one is only where it was put once
 * the page is back in it. So the widget loads that address with `cw-goto=<id>`
 * on the end, and the page list (`widget-page-list.ts`) takes it off again and
 * shows the thread once the page has it.
 *
 * A load rather than `pushState`: a page that renders on the server, or a
 * router that ignores a `popstate` it did not push, would move the address
 * and leave the page as it was. The id rides in the address rather than in
 * session storage because an app on the board runs in a sandboxed frame whose
 * storage is a stand-in that a load throws away (`mock-bridge.ts`).
 *
 * Added and removed as text, never through `URLSearchParams`: that would
 * re-encode the rest of the query (`%20` as `+`), and the address would no
 * longer be the one the thread was made at.
 */
export function goTo(url: string, threadId: string): void {
  const [path = '', hash] = url.split(/#(.*)/s);
  const sep = path.includes('?') ? '&' : '?';
  location.assign(
    `${path}${sep}cw-goto=${encodeURIComponent(threadId)}${hash === undefined ? '' : `#${hash}`}`,
  );
}

/** The thread `goTo` asked for in `url`, and `url` without it; or null. */
export function takeGoTo(url: string): { id: string; rest: string } | null {
  const m = /[?&]cw-goto=([^&#]*)/.exec(url);
  if (!m) return null;
  const rest = url.replace(m[0], '').replace(/^([^?#]*)&/, '$1?');
  try {
    return { id: decodeURIComponent(m[1] ?? ''), rest };
  } catch {
    return { id: '', rest };
  }
}
