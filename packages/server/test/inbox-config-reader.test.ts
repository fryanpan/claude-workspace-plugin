/**
 * The inbox config is re-read when its file changes, so writing it after
 * boot takes effect on the next post. A rewrite that is not JSON keeps the
 * last good config and is logged once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxConfigReader } from '../src/inbox/config.ts';

let dir: string;
let lines: string[];
const file = () => join(dir, 'inbox', 'config.json');
const write = (body: string) => {
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  writeFileSync(file(), body);
};
const reader = () => inboxConfigReader(dir, (l) => lines.push(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-config-reader-'));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('inboxConfigReader', () => {
  it('picks up a file written after the first read', () => {
    const config = reader();
    expect(config().readerAgentId).toBeNull();
    write(JSON.stringify({ readerAgentId: 'agent-reader' }));
    expect(config().readerAgentId).toBe('agent-reader');
  });

  it('picks up a rewrite, Slack workspaces included', () => {
    write(JSON.stringify({ readerAgentId: 'agent-reader' }));
    const config = reader();
    expect(config().workspaces.has('harbor')).toBe(false);
    write(
      JSON.stringify({
        readerAgentId: 'agent-riverbend',
        slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
      }),
    );
    expect(config().readerAgentId).toBe('agent-riverbend');
    expect(config().workspaces.get('harbor')?.slackHost).toBe('harborlight');
  });

  it('keeps the last good config through a rewrite that is not JSON, logging it once', () => {
    write(JSON.stringify({ readerAgentId: 'agent-reader' }));
    const config = reader();
    expect(config().readerAgentId).toBe('agent-reader');
    write('{"readerAgentId": "agent-saltm');
    for (let i = 0; i < 5; i++) expect(config().readerAgentId).toBe('agent-reader');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('keeping the last good config');
    write(JSON.stringify({ readerAgentId: 'agent-saltmarsh' }));
    expect(config().readerAgentId).toBe('agent-saltmarsh');
  });

  it('lets nobody post when the file is not JSON at the first read, as at boot', () => {
    write('{not json');
    const config = reader();
    expect(config().readerAgentId).toBeNull();
    expect(config().readerAgentId).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('nobody may post rows');
  });

  it('falls back to the built-ins when the file is removed', () => {
    write(JSON.stringify({ readerAgentId: 'agent-reader' }));
    const config = reader();
    expect(config().readerAgentId).toBe('agent-reader');
    unlinkSync(file());
    expect(config().readerAgentId).toBeNull();
    expect([...config().workspaces.keys()]).toEqual(['email', 'texts']);
  });
});
