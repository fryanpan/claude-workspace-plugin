/**
 * The allow rules a `grant` card may carry, and the one judgement of which
 * lines are narrow enough to put in front of the board's owner.
 *
 * A grant card is how a lead asks, once and before work starts, for every
 * owner-only command a task will run. When the owner approves it in the
 * browser, the server writes exactly these lines into `permissions.allow` of
 * their user settings, and takes them out again when the task closes (see
 * `packages/server/src/permission-grants.ts`). So each line is an argument to
 * a write on the owner's machine, and this module decides what may be one.
 *
 * WHAT IS REFUSED, and why each is a refusal rather than a warning:
 *  - A bare tool name — `Bash`, `WebFetch`, `mcp__server__tool`. Claude Code
 *    reads a rule with no specifier as the whole tool, so `Bash` would allow
 *    every command, which is the opposite of a grant scoped to one task.
 *  - A specifier that covers the whole tool anyway — `Bash(*)`, `Bash(:*)`,
 *    `Read(~/**)`, `WebFetch(domain:*)`. The test is that the specifier names
 *    something: it must hold a letter or digit once a `domain:` prefix is set
 *    aside. Wildcards and path separators alone name everything.
 *  - A specifier that starts with a wildcard — `Bash(*a*)` holds a letter but
 *    still matches nearly every command.
 *  - A Bash rule whose first word is a shell, interpreter or command runner —
 *    `Bash(sh:*)`, `Bash(python3 -c:*)`, `Bash(sudo:*)`. Each runs whatever
 *    follows it, so the rule is the whole tool.
 *  - A file-tool rule on the disk root or home directory — `Write(/**)`,
 *    `Edit(~/**)`.
 *  - Anything that is not one line of printable text, or that runs past
 *    `GRANT_LIMITS.ruleMaxChars`. The card shows the line verbatim; a line
 *    break would let the card show one thing and the file receive another.
 *
 * Deny and ask rules have no spelling here at all. A card carries allow lines
 * and nothing else, and `checkAllowRules` refuses a payload that tries to
 * name `deny`, `ask` or a whole `permissions` block.
 */

export const GRANT_LIMITS = {
  /** One card, one task's commands. Twenty fits a phone as a list. */
  maxRules: 20,
  /** Longer than any real prefix rule; a pasted script is not one. */
  ruleMaxChars: 200,
} as const;

/** `Tool(specifier)`: a tool name, then a non-empty specifier in parens. */
const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_-]*)\((.+)\)$/;

/**
 * Why `rule` may not be written, as a sentence for the filing agent, or
 * undefined when it is a line the card may carry.
 */
export function permissionRuleProblem(rule: unknown): string | undefined {
  if (typeof rule !== 'string' || rule.trim() === '') {
    return 'must be a non-empty string such as `Bash(git push --force-with-lease:*)`';
  }
  if (rule !== rule.trim()) return 'must not start or end with whitespace';
  if (rule.length > GRANT_LIMITS.ruleMaxChars) {
    return `is ${rule.length} characters; at most ${GRANT_LIMITS.ruleMaxChars}`;
  }
  // Control characters of any kind, line breaks included.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  if (/[\u0000-\u001f\u007f]/.test(rule)) return 'must be one line of printable text';
  const m = RULE_SHAPE.exec(rule);
  if (!m) {
    return 'must name a tool AND what it may do, like `Bash(git push:*)` — a bare tool name allows the whole tool';
  }
  const tool = m[1] ?? '';
  const raw = m[2] ?? '';
  if (FILE_TOOLS.has(tool) && FILE_ROOTS.has(raw.replace(/^\/\//, '/'))) {
    return 'opens every file — the path has to name a directory inside a project, like `Edit(src/**)`';
  }
  const spec = raw.replace(/^domain:/, '');
  if (!/[A-Za-z0-9]/.test(spec)) {
    return 'covers the whole tool — the part in parentheses has to name a command, path or domain';
  }
  if (raw.startsWith('*')) {
    return 'starts with a wildcard, which matches nearly anything — start with the command, path or domain itself';
  }
  if (tool === 'Bash') {
    const first = (raw.split(/[ :]/, 1)[0] ?? '').split('/').pop() ?? '';
    if (COMMAND_RUNNERS.has(first)) {
      return `starts with \`${first}\`, which runs any command it is given — name the command itself`;
    }
  }
  return undefined;
}

/** Tools whose specifier is a path. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Paths that name the whole disk or the whole home directory. */
const FILE_ROOTS = new Set(['/', '~', '/**', '~/**', '**']);

/**
 * Shells, interpreters and command runners: a prefix rule on any of them
 * allows whatever command follows, so `Bash(sh:*)` is `Bash` by another name.
 */
const COMMAND_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'env',
  'eval',
  'exec',
  'sudo',
  'su',
  'xargs',
  'nohup',
  'time',
  'command',
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'osascript',
]);

/** True when `rule` is a line a grant card may carry. */
export function isGrantableRule(rule: unknown): rule is string {
  return permissionRuleProblem(rule) === undefined;
}

/**
 * The rules on a stored payload, read back defensively: a line that would not
 * be admitted today is dropped, so no reader hands the settings writer a line
 * the gate would refuse. Undefined when none survive.
 */
export function readAllowRules(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (isGrantableRule(raw) && !out.includes(raw)) out.push(raw);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The filing gate's half for this shape. `fail` is `checkReviewPayload`'s own
 * collector, so a grant card's refusals read like every other refusal.
 */
export function checkAllowRules(
  p: Record<string, unknown>,
  shape: string | undefined,
  fail: (msg: string) => void,
): void {
  const raw = p.allowRules;
  if (raw !== undefined && shape !== 'grant') {
    fail(
      "review.allowRules belong to a 'grant' card. Set review_type to 'grant' to ask for permissions, or drop them.",
    );
    return;
  }
  if (shape !== 'grant') return;
  for (const key of ['deny', 'ask', 'permissions'] as const) {
    if (p[key] !== undefined) {
      fail(
        `review.${key} is refused: a 'grant' card only ADDS allow rules, listed in review.allowRules. It never changes deny or ask rules.`,
      );
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(
      "a 'grant' card needs review.allowRules: one line per permission, each like `Bash(git push --force-with-lease:*)`.",
    );
    return;
  }
  if (raw.length > GRANT_LIMITS.maxRules) {
    fail(
      `review.allowRules has ${raw.length} lines; at most ${GRANT_LIMITS.maxRules} fit one card.`,
    );
  }
  const seen = new Set<string>();
  raw.forEach((rule, i) => {
    const problem = permissionRuleProblem(rule);
    if (problem) {
      fail(`review.allowRules[${i}] ${problem}.`);
    } else if (seen.has(rule as string)) {
      fail(`review.allowRules[${i}] repeats ${JSON.stringify(rule)}; list each line once.`);
    } else {
      seen.add(rule as string);
    }
  });
}
