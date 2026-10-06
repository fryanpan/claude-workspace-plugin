/**
 * A preview of one of the board's apps beside the markdown it renders, so an
 * edit to the doc shows up in the page it builds without leaving the editor.
 *
 * The toolbar's ◧ button opens a pane holding an address field and a frame.
 * Above the 1100px mobile tier the pane takes half the width beside the
 * editor; at or below it the pane covers the editor and the same button puts
 * the editor back. Which page and whether it was open are kept per doc on
 * this device (`doc-preview-model.ts`).
 *
 * The frame is the board embed's: an app-door address with `?cw-frame=1`,
 * `sandbox="allow-scripts"` and never `allow-same-origin`, because the app
 * door serves on our own origin. Only an address under this board's app
 * doors is loaded at all.
 *
 * Reload: a change to the prose (not to comments, which live in the same
 * ydoc) schedules a reload once the write-back has flushed the file. The app
 * door relays a dev server's event stream but not a websocket, so some apps
 * reload themselves through it and some cannot; a page that loads by itself
 * inside the window cancels ours.
 */
import { getProseFragment } from '@claude-workspaces/core/prose';
import type * as Y from 'yjs';
import { currentWorkspaceId } from '../doc-path.ts';
import type { MountScope } from '../mount-scope.ts';
import {
  PREVIEW_RELOAD_MS,
  appDoorPrefix,
  createReloadScheduler,
  previewFrameSrc,
  readPreviewPref,
  writePreviewPref,
} from './doc-preview-model.ts';

export interface DocPreviewOptions {
  docId: string;
  ydoc: Y.Doc;
  scope: MountScope;
  /** Test seam; the page reads the address. */
  workspaceId?: string | null;
  reloadMs?: number;
}

export interface DocPreview {
  pane: HTMLElement;
  frame: HTMLIFrameElement;
  toggle: HTMLButtonElement;
}

export function mountDocPreview(opts: DocPreviewOptions): DocPreview | null {
  const { docId, ydoc, scope } = opts;
  const workspaceId = opts.workspaceId === undefined ? currentWorkspaceId() : opts.workspaceId;
  const main = document.getElementById('main');
  const toolbar = document.querySelector<HTMLElement>('#topbar .toolbar');
  if (!workspaceId || !main || !toolbar) return null;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'toggle-preview';
  toggle.className = 'icon-btn';
  toggle.title = 'Show app preview';
  toggle.setAttribute('aria-label', 'Toggle app preview');
  toggle.setAttribute('aria-controls', 'preview-pane');
  toggle.textContent = '◧';
  toolbar.prepend(toggle);

  const pane = document.createElement('aside');
  pane.id = 'preview-pane';
  pane.setAttribute('aria-label', 'App preview');
  const form = document.createElement('form');
  form.className = 'preview-bar';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'preview-path';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.setAttribute('aria-label', 'App page to preview');
  input.placeholder = `${appDoorPrefix(workspaceId)}<app>/`;
  const go = document.createElement('button');
  go.type = 'submit';
  go.textContent = 'Load';
  form.append(input, go);
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', 'App preview');
  const note = document.createElement('p');
  note.className = 'preview-note';
  pane.append(form, frame, note);
  const editorPane = document.getElementById('editor-pane');
  if (editorPane) editorPane.after(pane);
  else main.append(pane);

  const pref = readPreviewPref(docId);
  input.value = pref.path;
  let loaded = '';

  function load(): void {
    const src = previewFrameSrc(input.value, workspaceId ?? '', location.href);
    note.textContent = src ? '' : `Enter a page under ${appDoorPrefix(workspaceId ?? '')}`;
    frame.hidden = src === null;
    if (src && src !== loaded) {
      loaded = src;
      frame.src = src;
    }
  }

  function setOpen(open: boolean): void {
    document.body.classList.toggle('preview-open', open);
    toggle.setAttribute('aria-pressed', String(open));
    toggle.title = open ? 'Hide app preview' : 'Show app preview';
    writePreviewPref(docId, { path: input.value.trim(), open });
    if (open) load();
  }

  scope.listen(toggle, 'click', () => setOpen(!document.body.classList.contains('preview-open')));
  scope.listen(form, 'submit', (e) => {
    e.preventDefault();
    writePreviewPref(docId, { path: input.value.trim(), open: true });
    loaded = ''; // Load on the page already showing reloads it
    load();
  });

  const scheduler = createReloadScheduler({
    delayMs: opts.reloadMs ?? PREVIEW_RELOAD_MS,
    reload: () => {
      // Reassigning the same src reloads a cross-origin frame; its
      // `contentWindow.location` is not ours to touch.
      if (loaded && document.body.classList.contains('preview-open')) frame.src = loaded;
    },
  });
  scope.listen(frame, 'load', () => scheduler.frameLoaded());
  const fragment = getProseFragment(ydoc);
  const onProse = (): void => {
    if (loaded) scheduler.edited();
  };
  fragment.observeDeep(onProse);

  // With nothing chosen yet, start at the first app the board's embeds name.
  if (!pref.path) {
    void firstEmbedApp(workspaceId).then((app) => {
      if (!app || input.value) return;
      input.value = `${appDoorPrefix(workspaceId)}${app}/`;
      if (document.body.classList.contains('preview-open')) load();
    });
  }
  setOpen(pref.open);
  scope.onCleanup(() => {
    fragment.unobserveDeep(onProse);
    scheduler.dispose();
    document.body.classList.remove('preview-open');
    toggle.remove();
    pane.remove();
  });
  return { pane, frame, toggle };
}

async function firstEmbedApp(workspaceId: string): Promise<string | null> {
  try {
    const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/embeds`);
    if (!res.ok) return null;
    const body = (await res.json()) as { embeds?: Record<string, { appDocId?: unknown }> };
    const ids = Object.values(body.embeds ?? {}).map((e) => e.appDocId);
    const id = ids.find((v): v is string => typeof v === 'string');
    return id ? encodeURIComponent(id) : null;
  } catch {
    return null;
  }
}
