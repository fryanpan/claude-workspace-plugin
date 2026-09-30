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
 *    follows it, so the rule is the whole tool. The first word is compared
 *    lower-cased, without a leading `\` or a directory, because on macOS's
 *    case-insensitive volume `SH` runs `sh`; and it must be a plain command
 *    name, so `FOO=1 sh` or `"sh"` cannot hide one.
 *  - A Bash rule on a command that runs others unless its subcommand is named
 *    — `Bash(git:*)` (`git -c core.pager=…`), `Bash(npx:*)`, `Bash(ssh:*)` —
 *    and a subcommand that is itself a runner, `npm exec` or `git config`.
 *  - A file-tool rule that is not a path inside the project. Only relative
 *    paths are admitted: an absolute one (`/Users/**`), a home one
 *    (`~/.claude/**`) and a single leading `/` (which Claude Code reads
 *    against the settings file's own directory — for the file a grant
 *    writes, the config dir) are all refused, as is `..`, and any segment
 *    naming config, startup or credential files (`.claude`, `.git`,
 *    `.zshrc`). A grant that could edit a settings file would outlive its
 *    task: `release` takes back only the lines it wrote.
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
  if (raw !== raw.trimStart()) {
    return 'must not start with whitespace inside the parentheses — it hides the first word';
  }
  if (FILE_TOOLS.has(tool)) {
    const problem = filePathProblem(raw);
    if (problem) return problem;
  }
  const spec = raw.replace(/^domain:/, '');
  if (!/[A-Za-z0-9]/.test(spec)) {
    return 'covers the whole tool — the part in parentheses has to name a command, path or domain';
  }
  if (raw.startsWith('*')) {
    return 'starts with a wildcard, which matches nearly anything — start with the command, path or domain itself';
  }
  if (tool === 'Bash') return bashRuleProblem(raw);
  return undefined;
}

/** Tools whose specifier is a path. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Path segments a grant may never reach, compared lower-cased: the Claude
 * config dir (a project's own `.claude` holds settings too), git's hooks and
 * config, shell startup files, and credential stores. Each is a way to run a
 * command, or change what may run, after the task has closed.
 */
const PROTECTED_SEGMENTS = new Set([
  '.claude',
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.gitconfig',
]);

/**
 * A file rule must be a path inside the project, relative to it. Refusing
 * every absolute and home spelling is simpler than proving one is inside a
 * repo, and a relative path is always available to a task working in one.
 */
function filePathProblem(raw: string): string | undefined {
  if (/^[/~$]/.test(raw) || /[\\:]/.test(raw)) {
    return 'is not relative to the project — write the path from the project root, like `Edit(src/**)`; an absolute or home path can reach your settings and shell startup files';
  }
  if (!/^[A-Za-z0-9._\-/*@+ ]+$/.test(raw)) {
    return 'may use only letters, digits, spaces and `. - _ / * @ +` in a path, so a pattern cannot spell a protected name';
  }
  const segments = raw.replace(/^(\.\/)+/, '').split('/');
  const top = segments[0] ?? '';
  // A leading wildcard has its own refusal below, with its own advice.
  if ((!/[A-Za-z0-9]/.test(top) || top.startsWith('*')) && !raw.startsWith('*')) {
    return 'opens every file in the project — name a directory inside it, like `Edit(src/**)`';
  }
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === '..') return 'climbs out of the project with `..`';
    if (PROTECTED_SEGMENTS.has(lower) || (lower.startsWith('.') && lower.includes('*'))) {
      return `reaches \`${seg}\`, which holds settings, hooks, startup files or credentials`;
    }
  }
  return undefined;
}

/**
 * Why a Bash specifier is too broad, or undefined. Reads the first word the
 * way the shell will find it — case-folded, without a leading `\` or a
 * directory — and, for a command that runs others, the word after it.
 */
function bashRuleProblem(raw: string): string | undefined {
  const words = raw
    .replace(/:\*$/, '')
    .split(' ')
    .filter((w) => w !== '');
  const written = words[0] ?? '';
  const bare = written.replace(/^\\+/, '');
  if (!/^[A-Za-z0-9._+/-]+$/.test(bare)) {
    return `starts with \`${written}\`, which is not a plain command name — start with the command itself`;
  }
  const first = (bare.split('/').pop() ?? '').toLowerCase();
  if (COMMAND_RUNNERS.has(first) || RUNNER_FAMILIES.test(first)) {
    return `starts with \`${first}\`, which runs any command it is given — name the command itself`;
  }
  if (NEEDS_SUBCOMMAND.has(first)) {
    const sub = (words[1] ?? '').toLowerCase();
    if (!/^[a-z0-9]/.test(sub)) {
      return `names \`${first}\` without a subcommand, which lets it run other commands — name one, like \`${first} <subcommand>:*\``;
    }
    if (RUNNER_SUBCOMMANDS.has(`${first} ${sub}`)) {
      return `starts with \`${first} ${sub}\`, which runs any command it is given — name the command itself`;
    }
  }
  return undefined;
}

/**
 * Shells, interpreters and command runners: a prefix rule on any of them
 * allows whatever command follows, so `Bash(sh:*)` is `Bash` by another name.
 * `find` and `awk` are here because any prefix of theirs still takes `-exec`
 * or `system()`. Not complete and cannot be — the owner reading each line is
 * the last check — but every name here is one that was tried.
 */
const COMMAND_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'ash',
  'busybox',
  'env',
  'eval',
  'exec',
  'source',
  '.',
  'sudo',
  'su',
  'doas',
  'xargs',
  'nohup',
  'time',
  'timeout',
  'nice',
  'command',
  'builtin',
  'script',
  'expect',
  'watch',
  'caffeinate',
  'arch',
  'chroot',
  'sandbox-exec',
  'parallel',
  'deno',
  'bun',
  'osascript',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'find',
  'launchctl',
  'open',
  'tmux',
  'screen',
  'vi',
  'vim',
  'nvim',
  'emacs',
]);

/** Interpreters, with or without a version (`python3.12`, `node20`). */
const RUNNER_FAMILIES =
  /^(python|pypy|node|nodejs|ruby|perl|php|lua|luajit|tclsh|pwsh|rscript|julia)[0-9.]*$/;

/**
 * Commands that run others through their bare form or an option before the
 * subcommand (`git -c core.pager=…`, `npx <anything>`): a rule on one must
 * name the subcommand, or for the package runners the package.
 */
const NEEDS_SUBCOMMAND = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'make',
  'ssh',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'uv',
  'docker',
  'cargo',
  'go',
  'gh',
]);

/** Subcommands that are themselves runners. */
const RUNNER_SUBCOMMANDS = new Set([
  'npm exec',
  'npm x',
  'pnpm exec',
  'pnpm dlx',
  'yarn exec',
  'yarn dlx',
  'uv run',
  'uv tool',
  'docker run',
  'docker exec',
  'git config',
  'git submodule',
  'git bisect',
  'git filter-branch',
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
