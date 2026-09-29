/** Who is told when an attached app stops answering, and how often (`app-outage.ts`). */
import { describe, expect, it } from 'bun:test';
import {
  APP_UNREACHABLE_EVENT,
  ASK_AGAIN_MS,
  type AppFailure,
  AppOutages,
} from '../src/app-outage.ts';

const FAILURE: AppFailure = {
  workspaceId: 'w-harbor',
  docId: 'd-harbor',
  title: 'Harborlight site',
  origin: 'http://127.0.0.1:4321',
  prefix: '/workspaces/w-harbor/apps/d-harbor/',
  reason: 'Unable to connect',
  attachedBy: 'agent-harborlight',
};

function harness(opts: { lead?: string; reached?: number } = {}) {
  const sent: Array<{ workspaceId: string; agentId: string; frame: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let t = 1_000;
  const outages = new AppOutages({
    leadOf: () => opts.lead,
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame: { ...frame } });
      return opts.reached ?? 1;
    },
    log: (l) => lines.push(l),
    now: () => t,
  });
  return { outages, sent, lines, advance: (ms: number) => (t += ms) };
}

describe('AppOutages', () => {
  it('tells the attacher once per outage, and again after the app answers', () => {
    const h = harness({ lead: 'agent-riverbend' });
    expect(h.outages.failed(FAILURE)).toBe(true);
    expect(h.outages.failed(FAILURE)).toBe(false);
    expect(h.outages.failed(FAILURE)).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.agentId).toBe('agent-harborlight');
    expect(h.sent[0]?.frame).toMatchObject({
      event: APP_UNREACHABLE_EVENT,
      docId: 'd-harbor',
      origin: FAILURE.origin,
      addressedAs: 'attacher',
    });
    h.advance(90_000);
    h.outages.answered('d-harbor');
    expect(h.lines.at(-1)).toBe('[apps] d-harbor answering again after 90s down');
    expect(h.outages.failed(FAILURE)).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it('keeps each app’s outage separate', () => {
    const h = harness();
    h.outages.failed(FAILURE);
    h.outages.failed({ ...FAILURE, docId: 'd-riverbend' });
    expect(h.sent.map((s) => s.frame.docId)).toEqual(['d-harbor', 'd-riverbend']);
  });

  it('falls back to the board lead when the attach recorded nobody', () => {
    const h = harness({ lead: 'agent-riverbend' });
    const { attachedBy: _, ...unrecorded } = FAILURE;
    h.outages.failed(unrecorded);
    expect(h.sent[0]?.agentId).toBe('agent-riverbend');
    expect(h.sent[0]?.frame.addressedAs).toBe('lead');
  });

  it('logs the outage when there is nobody to tell, and still counts it once', () => {
    const h = harness();
    const { attachedBy: _, ...unrecorded } = FAILURE;
    expect(h.outages.failed(unrecorded)).toBe(true);
    expect(h.outages.failed(unrecorded)).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toStartWith('[apps] d-harbor on w-harbor stopped answering');
    expect(h.lines[0]).toContain('nobody to tell');
  });

  it('says when the addressee holds no stream, so the frame waits for its reconnect', () => {
    const h = harness({ reached: 0 });
    h.outages.failed(FAILURE);
    expect(h.lines[0]).toContain('not listening now');
  });

  it('logs no recovery for an app that was never down', () => {
    const h = harness();
    h.outages.answered('d-harbor');
    expect(h.lines).toHaveLength(0);
  });

  it('asks again only once two minutes have passed since the last notice', () => {
    const h = harness();
    h.outages.failed(FAILURE);
    h.advance(ASK_AGAIN_MS - 1);
    expect(h.outages.askAgain('d-harbor')).toEqual({
      ok: false,
      reason: 'too_soon',
      retryAt: 1_000 + ASK_AGAIN_MS,
    });
    expect(h.sent).toHaveLength(1);
    h.advance(1);
    const asked = h.outages.askAgain('d-harbor');
    expect(asked).toEqual({
      ok: true,
      askedAt: 1_000 + ASK_AGAIN_MS,
      to: 'agent-harborlight',
      addressedAs: 'attacher',
    });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.agentId).toBe('agent-harborlight');
    expect(h.sent[1]?.frame).toMatchObject({
      event: APP_UNREACHABLE_EVENT,
      askedAgain: true,
      downSince: 1_000,
      ts: 1_000 + ASK_AGAIN_MS,
    });
    // A held-down button: every press inside the next window is refused.
    for (let i = 0; i < 5; i++) expect(h.outages.askAgain('d-harbor').ok).toBe(false);
    expect(h.sent).toHaveLength(2);
    h.advance(ASK_AGAIN_MS);
    expect(h.outages.askAgain('d-harbor').ok).toBe(true);
    expect(h.sent).toHaveLength(3);
  });

  it('reports the outage as the waiting page reads it', () => {
    const h = harness();
    expect(h.outages.outage('d-harbor')).toBeUndefined();
    h.outages.failed(FAILURE);
    expect(h.outages.outage('d-harbor')).toEqual({
      since: 1_000,
      askedAt: 1_000,
      to: 'agent-harborlight',
      addressedAs: 'attacher',
    });
    h.advance(ASK_AGAIN_MS);
    h.outages.askAgain('d-harbor');
    expect(h.outages.outage('d-harbor')).toMatchObject({
      since: 1_000,
      askedAt: 1_000 + ASK_AGAIN_MS,
      askedAgainAt: 1_000 + ASK_AGAIN_MS,
    });
    h.outages.answered('d-harbor');
    expect(h.outages.outage('d-harbor')).toBeUndefined();
  });

  it('asks the lead again when the lead was the one told', () => {
    const h = harness({ lead: 'agent-riverbend' });
    const { attachedBy: _, ...unrecorded } = FAILURE;
    h.outages.failed(unrecorded);
    h.advance(ASK_AGAIN_MS);
    expect(h.outages.askAgain('d-harbor')).toMatchObject({
      ok: true,
      to: 'agent-riverbend',
      addressedAs: 'lead',
    });
    expect(h.sent[1]?.frame.addressedAs).toBe('lead');
  });

  it('refuses to ask again when nobody was told, or the app is not down', () => {
    const h = harness();
    expect(h.outages.askAgain('d-harbor')).toEqual({ ok: false, reason: 'not_down' });
    const { attachedBy: _, ...unrecorded } = FAILURE;
    h.outages.failed(unrecorded);
    h.advance(ASK_AGAIN_MS);
    expect(h.outages.askAgain('d-harbor')).toEqual({ ok: false, reason: 'nobody' });
    expect(h.sent).toHaveLength(0);
  });
});
