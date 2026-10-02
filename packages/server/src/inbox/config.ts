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
 *
 * The server reads the file at boot and again whenever its mtime or size
 * changes (`inboxConfigReader`), so writing it takes effect on the next
 * post without a restart.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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

/** The file's contents as JSON: `{}` when absent, null when not JSON, which
 *  is logged in one line ending with what follows from it. */
function readRaw(path: string, log: (line: string) => void, verdict: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log(`[inbox] ${path} is not JSON (${(e as Error).message}); ${verdict}`);
    return null;
  }
}

function fromRaw(raw: unknown, log: (line: string) => void): InboxConfig {
  const { config, problems } = parseInboxConfig(raw);
  for (const p of problems) log(`[inbox] config: ${p}; left out`);
  return config;
}

const configPath = (dataDir: string) => join(dataDir, INBOX_DIRNAME, 'config.json');

/** The config on disk, or the built-ins alone with nobody allowed to post. */
export function loadInboxConfig(
  dataDir: string,
  log: (line: string) => void = (l) => console.warn(l),
): InboxConfig {
  return fromRaw(readRaw(configPath(dataDir), log, 'nobody may post rows') ?? {}, log);
}

/** What a stat says about the file: changes when it is written, created or
 *  removed. */
function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

/**
 * A getter for the current config, re-reading the file when its stamp
 * moves. The first read is `loadInboxConfig`'s, verdict included: a file
 * that is not JSON at boot lets nobody post. A later rewrite that is not
 * JSON keeps the last good config, and is logged once, since the stamp
 * does not move again until the file is next written. A removed file is
 * the built-ins alone, as at a boot with no file.
 */
export function inboxConfigReader(
  dataDir: string,
  log: (line: string) => void = (l) => console.warn(l),
): () => InboxConfig {
  const path = configPath(dataDir);
  let seen = stamp(path);
  let current = loadInboxConfig(dataDir, log);
  return () => {
    const now = stamp(path);
    if (now === seen) return current;
    seen = now;
    const raw = readRaw(path, log, 'keeping the last good config');
    if (raw !== null) current = fromRaw(raw, log);
    return current;
  };
}
