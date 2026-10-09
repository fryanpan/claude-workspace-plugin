import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { fileSandboxHeaders } from '../mockup-frame.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * An image a bound doc names by a path relative to its own `.md`.
 *
 *   GET /workspaces/<ws>/docs/<docId>/assets/<relative path>
 *
 * `![chart](img/chart.png)` beside a bound file renders on GitHub because
 * GitHub resolves the path against the file. The editor page is not beside
 * the file, so the editor rewrites a relative `src` to this address and the
 * `.md` keeps the path it was written with.
 *
 * What a request can reach is the doc's directory tree and nothing else:
 *
 *  - image extensions only (`IMAGE_TYPES`), checked before the disk is read
 *    and again on the file a symlink resolves to;
 *  - every segment decoded on its own, and refused if it is empty, `.`, `..`
 *    or carries a separator — `%2F` and `%5C` are how a path escapes a router
 *    that has already normalised the literal ones away;
 *  - the joined path resolved through `realpath` and required to sit under the
 *    realpath of the `.md`'s directory, so a symlink pointing out of the tree
 *    is refused for where it lands, not for what it is called.
 *
 * Gate: `share-scope`. The host guard admits `assets/*` on a doc only when the
 * doc is inside the shared board, the same line that admits the doc's text,
 * and an image the doc displays is part of that text.
 */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** The route segment the editor addresses a doc's relative images under. */
export const DOC_ASSETS_SEGMENT = 'assets';

export function handleDocAssetsRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Response | undefined {
  const { rest, req, docId } = rq;
  const { j } = ctx;
  if (!rest.startsWith(`${DOC_ASSETS_SEGMENT}/`)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const segments = decodeSegments(rest.slice(DOC_ASSETS_SEGMENT.length + 1));
  if (!segments) return j(400, { error: 'not a path inside the doc folder' });
  const type = IMAGE_TYPES[extname(segments[segments.length - 1] ?? '').toLowerCase()];
  if (!type) return j(415, { error: 'only images are served beside a doc' });
  const md = ctx.docStore.boundPathOf(docId);
  if (!md) return j(404, { error: 'this doc is not bound to a file' });
  const abs = resolveInside(dirname(md), segments);
  if (!abs) return j(404, { error: 'no image at that path beside the doc' });
  // Asked again of where a link LANDS: `chart.png -> notes.txt` is a text file.
  if (IMAGE_TYPES[extname(abs).toLowerCase()] !== type) {
    return j(415, { error: 'only images are served beside a doc' });
  }
  const size = statSync(abs).size;
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    // An `<img>` ignores both of these. A reader who opens the address on
    // its own gets an SVG as a download without scripts, never as a page on
    // this origin (`mount-file.ts` gives the same answer for the same reason).
    'content-disposition': type === 'image/svg+xml' ? 'attachment' : 'inline',
    ...fileSandboxHeaders(abs),
  };
  if (req.method === 'HEAD') {
    return new Response(null, { headers: { ...headers, 'content-length': String(size) } });
  }
  return new Response(Bun.file(abs), { headers });
}

/** Each segment decoded alone, or null when any of them could climb out. */
export function decodeSegments(raw: string): string[] | null {
  const parts = raw.split('/');
  const out: string[] = [];
  for (const part of parts) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out.length > 0 ? out : null;
}

/** The real path of `segments` under `root`, or null when it is outside or not a file. */
export function resolveInside(root: string, segments: string[]): string | null {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(join(realRoot, ...segments));
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + sep)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
