/**
 * The entry of `edit.js` — edit mode, fetched by the pencil on its first tap
 * or at load when the page has edits or an agent's suggestion waiting
 * (`edit-button.ts`). It hands its one function to the page on
 * `window.cwEdit`, as `voice.js` does; mounting the mode also gives the
 * thread popovers their Accept and Reject (`edit-suggest.ts`).
 */
import { mountEditMode } from './edit-mode.ts';
import { mountSuggestions } from './edit-suggest.ts';

window.cwEdit = {
  mountEditMode: (widget, button) => {
    mountSuggestions(widget);
    return mountEditMode(widget, button);
  },
};
