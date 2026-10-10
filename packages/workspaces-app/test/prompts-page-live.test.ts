/**
 * The prompts page redraws a prompt saved in another tab (`prompts.changed`
 * on `/api/prompts/events:stream`; `settings-app.ts` hands the frame to
 * `PromptsPageHandle.changed`), and never over words the reader is typing.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptDetail, PromptRow, PromptsApi } from '../src/settings/prompts-api.ts';
import { mountPromptsPage } from '../src/settings/prompts-page.ts';

const row = (edited: boolean): PromptRow => ({
  id: 'meeting-notes',
  name: 'Notetaking instructions',
  purpose: 'How the live note-taker writes the notes.',
  scope: 'server',
  editable: true,
  edited,
});

const detail = (value: string): PromptDetail => ({
  id: 'meeting-notes',
  name: 'Notetaking instructions',
  purpose: 'How the live note-taker writes the notes.',
  editable: true,
  value,
  isDefault: false,
  default: 'The shipped notetaking instructions.',
});

/** The server's answers, which "another tab" changes between reads. */
let rows: PromptRow[];
let words: string;
const api: PromptsApi = {
  list: async () => rows,
  detail: async () => detail(words),
  save: async () => ({ ok: true }),
};

function mount(pathname: string) {
  const loc = { pathname, search: '', assign: vi.fn() };
  return mountPromptsPage(root, { document, location: loc, history: { pushState() {} }, api });
}

let root: HTMLElement;
beforeEach(() => {
  rows = [row(false)];
  words = 'Two bullets per topic.';
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('a prompt saved in another tab', () => {
  it('marks the row Edited on the open list', async () => {
    const page = mount('/settings/prompts');
    await page.render();
    expect(root.querySelector('.prompt-edited')).toBeNull();
    rows = [row(true)];
    await page.changed();
    expect(root.querySelector('.prompt-edited')?.textContent).toBe('Edited');
  });

  it('puts the new words in an open editor the reader has not touched', async () => {
    const page = mount('/settings/prompts/meeting-notes');
    await page.render();
    words = 'Three bullets, as Riverbend asked.';
    await page.changed();
    expect((root.querySelector('#prompt-box') as HTMLTextAreaElement).value).toBe(words);
  });

  it('leaves words the reader is typing alone', async () => {
    const page = mount('/settings/prompts/meeting-notes');
    await page.render();
    const box = root.querySelector('#prompt-box') as HTMLTextAreaElement;
    box.value = 'Harborlight is half way through this';
    words = 'Saved somewhere else.';
    await page.changed();
    expect(box.value).toBe('Harborlight is half way through this');
  });
});
