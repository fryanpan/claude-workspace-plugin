/** The page a reader holds open while an app is down (`app-waiting-page.ts`). */
import { describe, expect, it } from 'bun:test';
import { ASK_AGAIN_MS } from '../src/app-outage.ts';
import { type AppWaitingModel, renderAppWaiting } from '../src/app-waiting-page.ts';

const BASE: AppWaitingModel = {
  app: 'Harborlight',
  boardHref: '/workspaces/w-harbor',
  askUrl: '/workspaces/w-harbor/apps/d-harbor',
  outage: { since: 1_000, askedAt: 1_000, to: 'agent-riverbend', addressedAs: 'attacher' },
  askedName: 'Riverbend',
  now: 2_000,
};

/** The data block the page's script reads. */
function dataOf(page: string): Record<string, unknown> {
  const m = page.match(/<script type="application\/json" id="cw-wait-data">([^<]*)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m?.[1] ?? '{}') as Record<string, unknown>;
}

describe('renderAppWaiting', () => {
  it('names the app and the attacher who was asked, and offers to ask again', () => {
    const page = renderAppWaiting(BASE);
    expect(page).toContain('<title>Harborlight is starting · Workspaces</title>');
    expect(page).toContain('<h1>Harborlight is starting</h1>');
    expect(page).toContain('We asked <b>Riverbend</b>, the agent that attached it');
    expect(page).toContain('It opens Harborlight by itself as soon as it answers.');
    expect(page).toContain('Waiting for Harborlight to answer.');
    expect(page).toContain('>Ask Riverbend again</button>');
    expect(page).toContain('<a href="/workspaces/w-harbor">Back to the board</a>');
  });

  it('names the lead when no attacher was recorded', () => {
    const page = renderAppWaiting({
      ...BASE,
      outage: { since: 1_000, askedAt: 1_000, to: 'agent-saltmarsh', addressedAs: 'lead' },
      askedName: 'Saltmarsh',
    });
    expect(page).toContain('so we asked <b>Saltmarsh</b>, who leads this board');
    expect(page).toContain('>Ask Saltmarsh again</button>');
  });

  it('says nobody was asked, and offers no button, when there was nobody to ask', () => {
    const { askedName: _, ...rest } = BASE;
    const page = renderAppWaiting({ ...rest, outage: { since: 1_000, askedAt: 1_000 } });
    expect(page).toContain('nobody was asked to start it');
    expect(page).not.toContain('<button');
    expect(dataOf(page).name).toBeNull();
  });

  it('hands the script the server’s instants and the ask window', () => {
    const data = dataOf(
      renderAppWaiting({
        ...BASE,
        outage: { ...BASE.outage, askedAt: 5_000, askedAgainAt: 5_000 },
      }),
    );
    expect(data).toMatchObject({
      since: 1_000,
      askedAt: 5_000,
      askedAgainAt: 5_000,
      now: 2_000,
      askAgainMs: ASK_AGAIN_MS,
      askUrl: BASE.askUrl,
      name: 'Riverbend',
    });
  });

  it('escapes every name, in the markup and in the script data', () => {
    const hostile = 'Harbor</script><script>alert(1)</script>';
    const page = renderAppWaiting({ ...BASE, app: hostile, askedName: '<img src=x onerror=1>' });
    expect(page).not.toContain('<script>alert(1)');
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('Harbor&lt;/script&gt;');
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    // The JSON block still parses to the raw names: nothing closed it early.
    const data = dataOf(page);
    expect(data.app).toBe(hostile);
    expect(data.name).toBe('<img src=x onerror=1>');
  });
});
