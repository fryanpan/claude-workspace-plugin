/**
 * Board embeds: a doc paragraph whose whole text is `::name{block="x"}` shows
 * a live frame of one of the board's apps beneath it.
 *
 * The board holds the mapping from directive name to app and path; the doc
 * only names a block. The server checks a mapping's shape before it stores
 * it, and the editor builds the frame's address here, so both read one rule.
 * Only `block` ever reaches a URL, and only after it matches `BLOCK_RE`.
 */
import { MOCK_FRAME_PARAM } from './page-thread-link.ts';

export interface BoardEmbedTarget {
  /** The app door the frame loads from: `/workspaces/<ws>/apps/<appDocId>`. */
  appDocId: string;
  /** The path under it, e.g. `{mount}/embed/bike/{block}/`. */
  pathTemplate: string;
}

export type BoardEmbeds = Record<string, BoardEmbedTarget>;

export const EMBED_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const BLOCK_RE = /^[a-z0-9-]{1,64}$/;
const APP_DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `{mount}` first, then plain path characters and `{block}`; no `..`. */
const TEMPLATE_RE = /^\{mount\}(?:\/[A-Za-z0-9_.{}-]*)*$/;
export const MAX_EMBEDS = 16;
/** Asks the app door to leave the comment widget out of an embed's page. */
export const EMBED_PARAM = 'cw-embed';

/** The frame heights an embed may ask for. */
export const EMBED_MIN_HEIGHT = 80;
export const EMBED_MAX_HEIGHT = 2000;

export function clampEmbedHeight(h: number): number {
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Math.round(h)));
}

/** A mapping the server may store, or the sentence saying why not. */
export function parseBoardEmbeds(
  raw: unknown,
): { ok: true; embeds: BoardEmbeds } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'embeds must be an object of name → {appDocId, pathTemplate}' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_EMBEDS) return { ok: false, error: `at most ${MAX_EMBEDS} embeds` };
  const embeds: BoardEmbeds = {};
  for (const [name, v] of entries) {
    if (!EMBED_NAME_RE.test(name)) {
      return { ok: false, error: `embed name ${JSON.stringify(name)} must match ${EMBED_NAME_RE}` };
    }
    const t = v as Partial<BoardEmbedTarget> | null;
    if (!t || typeof t.appDocId !== 'string' || !APP_DOC_ID_RE.test(t.appDocId)) {
      return { ok: false, error: `${name}: appDocId must match ${APP_DOC_ID_RE}` };
    }
    if (
      typeof t.pathTemplate !== 'string' ||
      t.pathTemplate.length > 200 ||
      !TEMPLATE_RE.test(t.pathTemplate) ||
      t.pathTemplate.includes('..')
    ) {
      return {
        ok: false,
        error: `${name}: pathTemplate must start with {mount} and hold only path characters, {mount} and {block}`,
      };
    }
    embeds[name] = { appDocId: t.appDocId, pathTemplate: t.pathTemplate };
  }
  return { ok: true, embeds };
}

/** The directive a paragraph's whole text spells, or null. */
export function parseEmbedDirective(text: string): { name: string; block: string } | null {
  const m = text.match(/^::([a-z][a-z0-9-]{0,31})\{([^{}\n]*)\}$/);
  if (!m) return null;
  const block = (m[2] ?? '').match(/(?:^|\s)block="([^"]*)"(?:\s|$)/)?.[1];
  if (block === undefined || !BLOCK_RE.test(block)) return null;
  return { name: m[1] ?? '', block };
}

/** The frame's same-origin path for a directive, or null when unmapped. */
export function embedUrl(
  embeds: BoardEmbeds | null | undefined,
  workspaceId: string,
  name: string,
  block: string,
): string | null {
  const target = embeds && Object.hasOwn(embeds, name) ? embeds[name] : undefined;
  if (!target || !BLOCK_RE.test(block)) return null;
  const mount = `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(target.appDocId)}`;
  // `?cw-frame=1` asks the app door for the app's own page rather than the
  // host page that frames it, so the page's height message reaches this
  // editor as its parent (`mockup-frame.ts` on the server); `cw-embed=1`
  // leaves the comment widget off it.
  const path = target.pathTemplate.split('{mount}').join(mount).split('{block}').join(block);
  return `${path}?${MOCK_FRAME_PARAM}=1&${EMBED_PARAM}=1`;
}
