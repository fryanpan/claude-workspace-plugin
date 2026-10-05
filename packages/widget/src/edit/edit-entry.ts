/**
 * The entry of `edit.js` — edit mode, fetched by the pencil on its first tap
 * or at load when the page has edits or an agent's suggestion waiting
 * (`edit-button.ts`). It hands its one function to the page on
 * `window.cwEdit`, as `voice.js` does; mounting the mode also gives the
 * thread popovers their Accept and Reject (`edit-suggest.ts`), and draws an
 * edit's comment as its word diff (`edit-diff-view.ts`).
 */
import { mountDiffView } from './edit-diff-view.ts';
import { mountEditMode } from './edit-mode.ts';
import { mountSuggestions } from './edit-suggest.ts';

window.cwEdit = {
  mountEditMode: (widget, button) => {
    mountSuggestions(widget);
    mountDiffView(widget);
    return mountEditMode(widget, button);
  },
};
