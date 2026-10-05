import {
  type BoardEmbeds,
  clampEmbedHeight,
  embedUrl,
  parseEmbedDirective,
} from '@claude-workspaces/core/board-embeds';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * A paragraph whose whole text is `::name{block="x"}` shows a live frame of
 * the board's mapped app beneath it (`@claude-workspaces/core/board-embeds`).
 *
 * STRICTLY RENDER-TIME, like the plan placeholder: the line stays an ordinary
 * paragraph with its own text, and the frame is a widget decoration after it,
 * so the stored doc and its markdown never change.
 *
 * The app door serves on our own origin, so the frame gets `allow-scripts`
 * and never `allow-same-origin`. Its height comes from a
 * `{type:"sfworks:height", block, height}` message, taken only when the
 * message's source is that frame's own window.
 *
 * Click to activate: a frame starts inert under a "Tap to interact" hint so
 * the doc scrolls past it; a tap activates it, and a tap outside it or Escape
 * puts it back.
 */

const key = new PluginKey<DecorationSet>('board-embed-frames');
const META_KEY = 'boardEmbedsLoaded';
const DEFAULT_HEIGHT = 320;

export interface BoardEmbedFramesOptions {
  /** The board the doc is on; null installs nothing. */
  workspaceId: string | null;
  /** Reads the board's mapping; null or a throw shows no frames. */
  load: () => Promise<BoardEmbeds | null>;
}

async function defaultLoad(workspaceId: string): Promise<BoardEmbeds | null> {
  const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/embeds`);
  if (!res.ok) return null;
  const body = (await res.json()) as { embeds?: BoardEmbeds };
  return body.embeds ?? null;
}

function frameEl(url: string, block: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'board-embed';
  wrap.contentEditable = 'false';
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('title', block);
  frame.dataset.embedBlock = block;
  frame.style.height = `${DEFAULT_HEIGHT}px`;
  frame.src = url;
  // Inactive, the frame takes no pointer events, so a wheel or a swipe over
  // it scrolls the doc; a tap anywhere on it hands it the pointer.
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'board-embed-hint';
  hint.textContent = 'Tap to interact';
  wrap.append(frame, hint);
  wrap.addEventListener('click', () => setActive(wrap, true));
  return wrap;
}

function setActive(wrap: Element, on: boolean): void {
  wrap.classList.toggle('is-active', on);
}

function build(doc: ProseNode, workspaceId: string, embeds: BoardEmbeds | null): DecorationSet {
  if (!embeds) return DecorationSet.empty;
  const decos: Decoration[] = [];
  const seen = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    const d = parseEmbedDirective(node.textContent);
    const url = d ? embedUrl(embeds, workspaceId, d.name, d.block) : null;
    if (d && url) {
      // Keyed on the address and its count, so an edit elsewhere keeps the
      // frame (and its loaded page) rather than reloading it.
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      decos.push(
        Decoration.widget(pos + node.nodeSize, () => frameEl(url, d.block), {
          key: `embed:${url}#${n}`,
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

function hasDirective(doc: ProseNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name !== 'paragraph') return true;
    if (parseEmbedDirective(node.textContent)) found = true;
    return false;
  });
  return found;
}

export const BoardEmbedFrames = Extension.create<BoardEmbedFramesOptions>({
  name: 'boardEmbedFrames',

  addOptions() {
    return { workspaceId: null, load: async () => null };
  },

  addProseMirrorPlugins() {
    const { workspaceId, load } = this.options;
    if (!workspaceId) return [];
    let embeds: BoardEmbeds | null = null;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_cfg, s) => build(s.doc, workspaceId, embeds),
          apply: (tr, prev) =>
            tr.docChanged || tr.getMeta(META_KEY)
              ? build(tr.doc, workspaceId, embeds)
              : prev.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
        view(view) {
          let live = true;
          let asked = false;
          // The mapping is read once, and only when the doc first holds a
          // directive line, so a doc without one makes no request.
          const ensureLoaded = (doc: ProseNode): void => {
            if (asked || !hasDirective(doc)) return;
            asked = true;
            load()
              .then((m) => {
                if (!live || !m) return;
                embeds = m;
                view.dispatch(view.state.tr.setMeta(META_KEY, true));
              })
              .catch(() => {});
          };
          ensureLoaded(view.state.doc);
          const onMessage = (ev: MessageEvent): void => {
            const data = ev.data as { type?: unknown; block?: unknown; height?: unknown } | null;
            if (data?.type !== 'sfworks:height' || typeof data.height !== 'number') return;
            if (!Number.isFinite(data.height)) return;
            for (const f of view.dom.querySelectorAll<HTMLIFrameElement>(
              'iframe[data-embed-block]',
            )) {
              if (ev.source === null || f.contentWindow !== ev.source) continue;
              if (f.dataset.embedBlock !== data.block) continue;
              f.style.height = `${clampEmbedHeight(data.height)}px`;
            }
          };
          window.addEventListener('message', onMessage);
          const deactivate = (keep: EventTarget | null): void => {
            for (const w of view.dom.querySelectorAll('.board-embed.is-active')) {
              if (!(keep instanceof Node && w.contains(keep))) setActive(w, false);
            }
          };
          const onPointerDown = (ev: PointerEvent): void => deactivate(ev.target);
          const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') deactivate(null);
          };
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('keydown', onKey);
          return {
            update(v) {
              ensureLoaded(v.state.doc);
            },
            destroy() {
              live = false;
              window.removeEventListener('message', onMessage);
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKey);
            },
          };
        },
      }),
    ];
  },
});

/** The extension wired to the board's own mapping route. */
export function boardEmbedFramesFor(workspaceId: string | null) {
  return BoardEmbedFrames.configure({
    workspaceId,
    load: () => (workspaceId ? defaultLoad(workspaceId) : Promise.resolve(null)),
  });
}
