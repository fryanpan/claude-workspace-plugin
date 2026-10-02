/**
 * Fixture rows for the inbox tests: invented senders, invented threads, the
 * house names only. `row()` is a row the checks accept; a test overrides the
 * one field it is about.
 */
import { parseInboxConfig } from '../src/inbox/config.ts';

export const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);

export const CONFIG = parseInboxConfig({
  readerAgentId: 'agent-reader',
  slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
}).config;

let n = 0;

export function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  const id = `thread${String(n).padStart(4, '0')}`;
  return {
    dedupeKey: `gmail:${id}`,
    source: 'gmail',
    workspace: 'email',
    senderLabel: 'Alice (Riverbend)',
    senderKey: 'a1b2c3d4e5f60718',
    senderKnown: true,
    purpose: 'Wants a yes on the Saltmarsh dates',
    body: 'Can we hold the 14th for the Saltmarsh walk? Need to know by Friday.',
    askKind: 'decision',
    replyBy: 'tomorrow',
    goal: null,
    link: `https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3${n.toString(16).padStart(4, '0')}`,
    receivedAt: NOW - 25 * 60_000,
    messageCount: 1,
    lastFromOwner: false,
    ...over,
  };
}
