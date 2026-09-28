/**
 * The parsing half of auth/agent-caller.ts, over captured command output, and
 * the decision it makes from a process tree. agent-token-mint.test.ts drives
 * the same code against the real operating system; this file pins the cases
 * that are awkward to build there: IPv6 sockets, the macOS `ps -E` layout, an
 * argument that mentions the variable, and each refusal.
 *
 * All names are house fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { agentIdForName } from '@claude-workspaces/core/identity';
import {
  type ProcessProbe,
  identifyCallerAgent,
  parseLsofPeer,
  parseProcEnviron,
  parseProcessTable,
  parsePsEnv,
} from '../src/auth/agent-caller.ts';

const HARBORLIGHT = agentIdForName('Harborlight');

describe('parseLsofPeer', () => {
  const out = [
    'p4100',
    'f12',
    'n127.0.0.1:50123->127.0.0.1:8787',
    'p900',
    'f19',
    'n127.0.0.1:8787->127.0.0.1:50123',
  ].join('\n');

  it('picks the process whose LOCAL end is the peer port', () => {
    expect(parseLsofPeer(out, 50123, 8787)).toBe(4100);
  });

  it('reads an IPv6 loopback socket', () => {
    expect(parseLsofPeer('p77\nn[::1]:50123->[::1]:8787', 50123, 8787)).toBe(77);
  });

  it('answers null when no process holds that end', () => {
    expect(parseLsofPeer(out, 50124, 8787)).toBeNull();
    expect(parseLsofPeer('', 50123, 8787)).toBeNull();
  });
});

describe('parsePsEnv', () => {
  it('reads the environment that follows the arguments', () => {
    const args = '/usr/local/bin/claude --resume\n';
    const full =
      '/usr/local/bin/claude --resume HOME=/home/x CW_AGENT_NAME=Harborlight Crew TERM=xterm\n';
    expect(parsePsEnv(args, full)).toEqual({
      HOME: '/home/x',
      CW_AGENT_NAME: 'Harborlight Crew',
      TERM: 'xterm',
    });
  });

  it('does not read an argument that merely mentions the variable', () => {
    const args = 'sh -c CW_AGENT_NAME=Riverbend true';
    expect(parsePsEnv(args, `${args} HOME=/home/x`)).toEqual({ HOME: '/home/x' });
  });
});

it('parseProcEnviron splits on NUL', () => {
  expect(parseProcEnviron('A=1\0CW_AGENT_NAME=Harborlight\0')).toEqual({
    A: '1',
    CW_AGENT_NAME: 'Harborlight',
  });
});

it('parseProcessTable keeps the basename of each command', () => {
  const table = parseProcessTable('  10     1 /opt/bin/claude\n  11    10 node\n');
  expect(table.get(10)).toEqual({ ppid: 1, name: 'claude' });
  expect(table.get(11)).toEqual({ ppid: 10, name: 'node' });
});

describe('identifyCallerAgent', () => {
  /** A Linux process tree: 1 -> 10 (a session) -> 11 (the caller). */
  function probe(over: Partial<ProcessProbe> & { environ?: Record<number, string> } = {}) {
    const environ = over.environ ?? {
      10: 'CW_AGENT_NAME=Harborlight\0',
      11: 'CW_AGENT_NAME=Harborlight\0CW_AUTHOR=agent\0',
    };
    const p: ProcessProbe = {
      platform: 'linux',
      selfPid: 1234,
      readFile: (path) => environ[Number(path.split('/')[2])] ?? null,
      async run(argv) {
        if (argv[0] === 'lsof') return 'p11\nn127.0.0.1:50123->127.0.0.1:8787\n';
        if (argv[0] === 'ps') return '10 1 claude\n11 10 node\n';
        return null;
      },
      ...over,
    };
    return p;
  }
  const peer = { address: '127.0.0.1', port: 50123 };

  it("names the session's agent", async () => {
    expect(await identifyCallerAgent(peer, 8787, probe())).toEqual({
      ok: true,
      agentId: HARBORLIGHT,
      via: 'session',
    });
  });

  it("falls back to the caller's own environment when the session names no agent", async () => {
    const p = probe({ environ: { 10: 'HOME=/x\0', 11: 'CW_AGENT_NAME=Harborlight\0' } });
    expect(await identifyCallerAgent(peer, 8787, p)).toEqual({
      ok: true,
      agentId: HARBORLIGHT,
      via: 'process',
    });
  });

  it('refuses a caller with no session above it', async () => {
    const p = probe({
      async run(argv) {
        if (argv[0] === 'lsof') return 'p11\nn127.0.0.1:50123->127.0.0.1:8787\n';
        return '11 1 node\n';
      },
    });
    expect((await identifyCallerAgent(peer, 8787, p)).ok).toBe(false);
  });

  it('refuses when lsof cannot run, rather than guessing', async () => {
    const p = probe({ run: async () => null });
    expect(await identifyCallerAgent(peer, 8787, p)).toEqual({
      ok: false,
      reason: 'lsof could not run',
    });
  });

  it('refuses the server itself', async () => {
    const p = probe({ selfPid: 11 });
    expect((await identifyCallerAgent(peer, 8787, p)).ok).toBe(false);
  });
});
