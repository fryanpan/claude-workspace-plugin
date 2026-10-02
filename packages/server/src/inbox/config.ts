/**
 * Which workspaces a row may name, and which agent may post rows.
 *
 * Two workspaces are built in: `email` (Gmail) and `texts` (Apple
 * Messages). Slack workspaces are configuration, because each one is a
 * real Slack team whose name and host belong to the owner, not to this
 * public repository. A row naming a workspace the config does not list is
 * refused, and a Slack link must be on the host its own workspace names,
 * so a row from one team cannot carry a link to another.
 *
 * The file is `<dataDir>/inbox/config.json`, written by hand:
 *
 *   { "readerAgentId": "<the reader session's agent id>",
 *     "slack": [{ "workspace": "harborlight", "label": "Harborlight", "host": "harborlight" }] }
 *
 * With no `readerAgentId` nobody may post: the reader's registration is
 * this one line until the reader session has a schedule row of its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxSource } from './types.ts';

export interface InboxWorkspace {
  /** The key a row names in `workspace`. */
  key: string;
  source: InboxSource;
  /** What the page shows beside the icon; empty for Email and Texts. */
  label: string;
  /** Slack only: the `<host>` of `<host>.slack.com`. */
  slackHost?: string;
}

export interface InboxConfig {
  readerAgentId: string | null;
  workspaces: ReadonlyMap<string, InboxWorkspace>;
}

const BUILT_IN: readonly InboxWorkspace[] = [
  { key: 'email', source: 'gmail', label: '' },
  { key: 'texts', source: 'messages', label: '' },
];

const SLACK_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const SLACK_HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLACK_LABEL = /^[\p{L}\p{N} ]{1,24}$/u;
const AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The config from its parsed JSON. An entry that does not pass its checks
 *  is left out and named in `problems`, rather than failing the whole file. */
export function parseInboxConfig(raw: unknown): { config: InboxConfig; problems: string[] } {
  const problems: string[] = [];
  const workspaces = new Map<string, InboxWorkspace>(BUILT_IN.map((w) => [w.key, w]));
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const reader = o.readerAgentId;
  const readerAgentId = typeof reader === 'string' && AGENT_ID.test(reader) ? reader : null;
  if (reader !== undefined && readerAgentId === null) problems.push('readerAgentId is not an id');
  const slack = Array.isArray(o.slack) ? o.slack : [];
  for (const [i, entry] of slack.entries()) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const { workspace, label, host } = e;
    if (
      typeof workspace !== 'string' ||
      !SLACK_KEY.test(workspace) ||
      workspaces.has(workspace) ||
      typeof host !== 'string' ||
      !SLACK_HOST.test(host) ||
      typeof label !== 'string' ||
      !SLACK_LABEL.test(label)
    ) {
      problems.push(`slack[${i}] is not a workspace, label and host`);
      continue;
    }
    workspaces.set(workspace, { key: workspace, source: 'slack', label, slackHost: host });
  }
  return { config: { readerAgentId, workspaces }, problems };
}

export const INBOX_DIRNAME = 'inbox';

/** The config on disk, or the built-ins alone with nobody allowed to post. */
export function loadInboxConfig(
  dataDir: string,
  log: (line: string) => void = (l) => console.warn(l),
): InboxConfig {
  const path = join(dataDir, INBOX_DIRNAME, 'config.json');
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      log(`[inbox] ${path} is not JSON (${(e as Error).message}); nobody may post rows`);
    }
  }
  const { config, problems } = parseInboxConfig(raw);
  for (const p of problems) log(`[inbox] config: ${p}; left out`);
  return config;
}
