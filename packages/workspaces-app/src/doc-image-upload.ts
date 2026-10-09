import { type Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { api } from './doc-path.ts';
import { showToast } from './doc/chrome-dom.ts';

/**
 * Adding an image to a bound doc without a URL: paste it, drop it, or pick
 * it from the Aa bar's "Attach image".
 *
 * Each file goes to `POST …/docs/<id>/assets` (`server/src/routes/doc-assets.ts`),
 * which stores it in `images/` beside the `.md` and answers the relative path.
 * The editor then inserts an image node with that path, so the `.md` gets
 * `![](images/…)` through the ordinary write-back and the image renders on
 * GitHub as it does here.
 *
 * Quiet by design: nothing appears until the file is stored, and only a
 * refusal says anything (one toast naming why).
 */
export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

function isImage(f: File): boolean {
  return f.type.startsWith('image/');
}

/** Store one file beside the doc; the relative `src` the server chose. */
export async function uploadDocImage(
  docId: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${api(`docs/${encodeURIComponent(docId)}/assets`)}?name=${encodeURIComponent(file.name)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const body = (await res.json().catch(() => null)) as { src?: string; error?: string } | null;
  if (!res.ok || typeof body?.src !== 'string') {
    throw new Error(body?.error ?? `upload failed (${res.status})`);
  }
  return body.src;
}

/**
 * Upload `files` in order and insert each image at `pos` (the caret when
 * omitted). Insertion waits for the store, so a refused file leaves no
 * placeholder behind to clean up.
 */
export async function insertDocImages(
  editor: Editor,
  docId: string,
  files: File[],
  pos?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let at = pos;
  for (const file of files.filter(isImage)) {
    let src: string;
    try {
      src = await uploadDocImage(docId, file, fetchImpl);
    } catch (err) {
      showToast(`Image not added: ${(err as Error).message}`);
      continue;
    }
    if (editor.isDestroyed) return;
    const where = at ?? editor.state.selection.from;
    editor
      .chain()
      .insertContentAt(where, { type: 'image', attrs: { src, alt: '' } })
      .run();
    // The next file goes after the one just placed, not in front of it.
    at = editor.state.selection.to;
  }
}

/** Open the browser's file picker and insert what the person chose. */
export function pickDocImages(editor: Editor, docId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPTED_IMAGE_TYPES;
  input.multiple = true;
  input.addEventListener('change', () => {
    void insertDocImages(editor, docId, Array.from(input.files ?? []));
  });
  input.click();
}

/** Paste and drop of image FILES; text and HTML pastes are left to the editor. */
export function docImagePaste(docId: string, fetchImpl: typeof fetch = fetch) {
  return Extension.create({
    name: 'docImagePaste',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          props: {
            handlePaste: (_view, event) => {
              const files = Array.from(event.clipboardData?.files ?? []).filter(isImage);
              if (files.length === 0 || !editor.isEditable) return false;
              event.preventDefault();
              void insertDocImages(editor, docId, files, undefined, fetchImpl);
              return true;
            },
            handleDrop: (view, event, _slice, moved) => {
              if (moved) return false;
              const files = Array.from(event.dataTransfer?.files ?? []).filter(isImage);
              if (files.length === 0 || !editor.isEditable) return false;
              event.preventDefault();
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
              void insertDocImages(editor, docId, files, pos, fetchImpl);
              return true;
            },
          },
        }),
      ];
    },
  });
}
