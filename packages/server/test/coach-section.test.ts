/**
 * "Your coach" as the front page draws it: one button before there is a
 * doc; after, the goals, the weekly offer when due, the how-readily
 * control with his setting pressed, the week's answers and today's events
 * — every word escaped.
 */
import { describe, expect, it } from 'bun:test';
import { type CoachSectionInput, renderCoachSection } from '../src/coach/section.ts';

const WEEK = {
  moments: 0,
  up: 0,
  down: 0,
  unanswered: 0,
  eventsToday: 0,
};
const base: CoachSectionInput = {
  docUrl: null,
  name: 'Your coach',
  online: true,
  goals: [],
  reviewDue: false,
  readiness: 'normal',
  week: WEEK,
  paused: false,
  offBoards: [],
};

describe('renderCoachSection', () => {
  it('offers only “Set up my coach” before there is a doc', () => {
    const html = renderCoachSection(base);
    expect(html).toContain('data-act="setup"');
    expect(html).not.toContain('data-readiness');
    expect(html).not.toContain('Learning goals</a>');
  });

  it('lists the goals and presses his setting', () => {
    const html = renderCoachSection({
      ...base,
      docUrl: '/workspaces/w-coach/docs/d-goals',
      name: 'Salt <b>marsh</b>',
      goals: ['Hard <i>work</i> first', 'Reply the same day'],
      readiness: 'less',
    });
    expect(html).toContain('<h2 id="coach-h">Salt &lt;b&gt;marsh&lt;/b&gt;</h2>');
    expect(html).toContain(
      '<li>Hard &lt;i&gt;work&lt;/i&gt; first</li><li>Reply the same day</li>',
    );
    expect(html).not.toContain('Act differently when');
    expect(html).not.toContain('add-goal');
    expect(html).toContain('data-readiness="less" aria-pressed="true"');
    expect(html).toContain('data-readiness="normal" aria-pressed="false"');
    expect(html).toContain('>How readily<');
    expect(html).toContain('only when it is plain');
    expect(html).not.toContain('data-review');
    expect(html).not.toContain('This week:');
    expect(html).not.toContain('Today it read');
    expect(html).not.toContain('Offline');
  });

  it('says it is offline when no coach session is listening', () => {
    const html = renderCoachSection({
      ...base,
      docUrl: '/workspaces/w-coach/docs/d-goals',
      goals: ['Hard work first'],
      online: false,
    });
    expect(html).toContain('Offline. No coach session is running, so it will not speak up.');
  });

  it('shows the weekly offer when due, and the week’s answers once there are moments', () => {
    const html = renderCoachSection({
      ...base,
      docUrl: '/workspaces/w-coach/docs/d-goals',
      goals: ['Hard work first'],
      reviewDue: true,
      week: {
        ...WEEK,
        moments: 4,
        up: 1,
        down: 2,
        unanswered: 1,
        eventsToday: 212,
      },
    });
    expect(html).toContain('href="/workspaces/w-coach/docs/d-goals">Review my goals</a>');
    expect(html).toContain('data-review="no-update"');
    expect(html).toContain('This week: 4 moments · Helpful 1 · Not helpful 2 · Left 1');
    expect(html).toContain('Today it read what you did 212 times, about $10.60 (estimate).');
    expect(html).not.toContain('Coach paused');
    expect(html).not.toContain('Coach off for');
  });

  it('says when the day’s budget is spent, and lists the boards he turned off, escaped', () => {
    const html = renderCoachSection({
      ...base,
      docUrl: '/workspaces/w-coach/docs/d-goals',
      goals: ['Hard work first'],
      paused: true,
      offBoards: [{ id: 'w-records', name: 'Saltmarsh <records>' }],
    });
    expect(html).toContain('Coach paused for today.');
    expect(html).toContain('Coach off for:');
    expect(html).toContain('Saltmarsh &lt;records&gt;');
    expect(html).toContain('data-coach-on="w-records"');
  });
});
