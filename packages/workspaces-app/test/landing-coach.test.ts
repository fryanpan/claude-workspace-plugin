/**
 * "This week" on the front page, driven as Bryan drives it: Edit opens the
 * goals, Save posts them with his time zone, and "Plans changed" posts the
 * answer, re-reads the section and opens the editor. The markup is the
 * shape `coach/section.ts` draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCoach } from '../src/landing-coach.ts';

const FORM = (open: boolean) =>
  `<form class="coach-edit" data-coach-edit${open ? '' : ' hidden'}><input name="goal" value="Publish the Harborlight post"><input name="goal" value=""><input name="goal" value="Reply to Saltmarsh"><button type="submit">Save goals</button><button type="button" data-act="cancel">Cancel</button></form>`;
const NUDGE =
  '<div class="coach-nudge" data-nudge="cn-aaaaaaaaaaaa"><p>Still on the post?</p><button type="button" data-answer="back-to-it">Back to it</button><button type="button" data-answer="plans-changed">Plans changed</button></div>';
const SECTION = (nudge: boolean) =>
  `<section id="coach"><button type="button" data-act="edit">Edit</button><ol><li>Publish the Harborlight post</li></ol>${nudge ? NUDGE : ''}${FORM(false)}</section>`;

type Call = { url: string; init?: RequestInit };
let calls: Call[];

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) await flush();
};

beforeEach(() => {
  document.body.innerHTML = SECTION(true);
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/') return new Response(`<html><body>${SECTION(false)}</body></html>`);
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  startCoach();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const form = () => document.querySelector<HTMLFormElement>('[data-coach-edit]');
const click = (sel: string) => document.querySelector<HTMLElement>(sel)?.click();

describe('This week', () => {
  it('Edit opens the goals and Cancel folds them again', () => {
    click('[data-act="edit"]');
    expect(form()?.hidden).toBe(false);
    click('[data-act="cancel"]');
    expect(form()?.hidden).toBe(true);
  });

  it('Save posts every field and the browser’s time zone, then re-reads the section', async () => {
    click('[data-act="edit"]');
    form()?.requestSubmit();
    await until(() => calls.some((c) => c.url === '/'));
    const save = calls.find((c) => c.url === '/coach/goals');
    expect(JSON.parse(String(save?.init?.body))).toEqual({
      goals: ['Publish the Harborlight post', '', 'Reply to Saltmarsh'],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('Plans changed posts the answer, clears the line and opens the editor', async () => {
    click('[data-answer="plans-changed"]');
    await until(() => form()?.hidden === false);
    const answer = calls.find((c) => c.url.startsWith('/coach/nudges/'));
    expect(answer?.url).toBe('/coach/nudges/cn-aaaaaaaaaaaa/answer');
    expect(JSON.parse(String(answer?.init?.body))).toEqual({ answer: 'plans-changed' });
    expect(document.querySelector('[data-nudge]')).toBeNull();
    expect(form()?.hidden).toBe(false);
  });
});
