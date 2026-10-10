/**
 * The banner on the workspaces list is told when a meeting is joined or left
 * (`landing-live.ts` calls `refresh`), so it does not poll the server. What
 * moves with the clock alone, the countdown and the offer's window, it
 * redraws from the events it already holds, without a read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCalendarEventsForTest } from '../src/calendar-events-source.ts';
import { MeetingBannerEl } from '../src/meeting-banner.ts';

const T0 = Date.parse('2026-10-08T15:00:00.000Z');
let reads: number;

function mount(): MeetingBannerEl {
  const el = document.createElement('meeting-banner') as MeetingBannerEl;
  el.setAttribute('pushed', '');
  el.now = () => Date.now();
  el.storage = { getItem: () => null, setItem: () => {} };
  el.fetchImpl = () => {
    reads += 1;
    const events = [
      {
        id: 'e1',
        title: 'Harborlight sync',
        startTime: new Date(T0).toISOString(),
        endTime: new Date(T0 + 30 * 60_000).toISOString(),
        hasMeetingLink: true,
        joinable: true,
        joined: false,
      },
    ];
    return Promise.resolve(new Response(JSON.stringify({ events })));
  };
  document.body.append(el);
  return el;
}

const text = (el: MeetingBannerEl) => el.shadowRoot?.textContent ?? '';
const at = (t: number) => vi.advanceTimersByTimeAsync(t - Date.now());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 - 20 * 60_000);
  reads = 0;
  document.body.innerHTML = '';
  _resetCalendarEventsForTest();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('a pushed <meeting-banner>', () => {
  it('opens and closes the offer on time, and reads the server once', async () => {
    const el = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    expect(text(el)).not.toContain('Harborlight sync');
    await at(T0 - 15 * 60_000);
    expect(text(el)).toContain('Starts in 15 min');
    await at(T0 - 5 * 60_000);
    expect(text(el)).toContain('Starts in 5 min');
    await at(T0 + 30 * 60_000);
    expect(text(el)).not.toContain('Harborlight sync');
    expect(reads).toBe(1);
  });

  it('re-reads when told to', async () => {
    const el = mount();
    await vi.advanceTimersByTimeAsync(0);
    await el.refresh();
    expect(reads).toBe(2);
  });
});
