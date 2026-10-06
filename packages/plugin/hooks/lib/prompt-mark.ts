/**
 * Prompt marks — the pure half of the plugin's UserPromptSubmit hook.
 *
 * The coach counts the owner's Claude Code time from the prompts he types,
 * and a turn note cannot say whether a person or a channel woke the turn. So
 * every prompt posts one mark to `POST /workspaces/{id}/agents/{name}/prompts`
 * saying only whether it was typed, with the session id and working
 * directory the turn notes already carry. The prompt's text never leaves
 * this machine: it is read here, classified, and dropped.
 *
 * A prompt is typed unless it starts with a wrapper the harness puts around
 * what it injects. The wrappers are the ones a lead session's transcript
 * holds on user turns: channel events, teammate messages, background task
 * notifications, system reminders, cross-session messages, and the plain
 * lead-ins the harness writes for a cross-session message, a resumed session
 * and a self-wake. A wrapper missing from this list reads as typed, which
 * overstates his time; it never hides it.
 *
 * Never blocks the prompt and never prints: a UserPromptSubmit hook's stdout
 * is added to the model's context, so every path here is silent and exits 0.
 */
import {
  type EnvLike,
  POST_TIMEOUT_MS,
  readAgentName,
  readWorkspaceId,
  resolveBaseUrl,
} from './agent-notes.ts';

/** How an injected prompt begins, after leading whitespace. */
export const INJECTED_PREFIXES: readonly string[] = [
  '<channel',
  '<teammate-message',
  '<task-notification',
  '<system-reminder',
  '<cross-session-message',
  'Another Claude session sent a message',
  'This session is being continued from a previous conversation',
  'Self-wake',
];

const SHORT_STRING_MAX = 200;

/** The wire body the prompts route accepts. No prompt text, ever. */
export interface PromptMark {
  agent: string;
  typed: boolean;
  cwd?: string;
  sessionId?: string;
  at: number;
}

/** True when a person typed it, false when the harness injected it, and
 *  undefined when the payload carries no prompt at all. */
export function isTypedPrompt(prompt: unknown): boolean | undefined {
  if (typeof prompt !== 'string') return undefined;
  const head = prompt.trimStart();
  if (head === '') return undefined;
  return !INJECTED_PREFIXES.some((p) => head.startsWith(p));
}

const shortString = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' && v.length <= SHORT_STRING_MAX ? v : undefined;

export function decidePromptMark(
  payload: unknown,
  ctx: { agent?: string; now: number },
): { post: PromptMark } | { skip: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { skip: 'malformed payload' };
  }
  if (!ctx.agent) return { skip: 'no agent name' };
  const p = payload as Record<string, unknown>;
  const typed = isTypedPrompt(p.prompt);
  if (typed === undefined) return { skip: 'no prompt' };
  const cwd = shortString(p.cwd);
  const sessionId = shortString(p.session_id);
  return {
    post: {
      agent: ctx.agent,
      typed,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      at: ctx.now,
    },
  };
}

export interface PromptHookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  now?: () => number;
  discoveryPort?: () => number | undefined;
}

/** Read stdin, decide, post. Answers whether a mark was delivered; never throws. */
export async function runPromptHook(stdin: string, deps: PromptHookDeps): Promise<boolean> {
  try {
    const decision = decidePromptMark(JSON.parse(stdin), {
      agent: readAgentName(deps.env),
      now: deps.now ? deps.now() : Date.now(),
    });
    if ('skip' in decision) return false;
    const workspaceId = readWorkspaceId(deps.env);
    const baseUrl = resolveBaseUrl(deps.env, deps.discoveryPort);
    if (!workspaceId || !baseUrl) return false;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(decision.post.agent)}/prompts`;
    const res = await (deps.fetch ?? fetch)(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision.post),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
