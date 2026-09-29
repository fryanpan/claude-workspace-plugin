/**
 * Permission grants — the allow rules a task holds in the owner's user
 * settings, from the moment its grant card is approved until it closes.
 *
 * A lead files ONE `grant` card per task, listing every owner-only command
 * the task will run (`Bash(git push --force-with-lease:*)`, …). The owner
 * approves it in the browser (`routes/task-grants.ts`), and this module
 * writes those lines into `permissions.allow` through
 * `settings-allow-file.ts`. When the task closes — moved to done, or
 * archived — it takes back the lines it added, and nothing else.
 *
 * THE LEDGER is what makes "nothing else" true. It is a sidecar in the data
 * dir, `permission-grants.json`, beside `allow-rule-proposals.json`, and it
 * records per line which open tasks hold it. Three consequences:
 *  - A line that was already in the file before the card was approved is
 *    the owner's own, is never entered in the ledger, and is never removed.
 *  - A line two open tasks both asked for is written once and held twice;
 *    closing one task leaves it for the other. It goes when the last holder
 *    closes.
 *  - A line the owner deleted by hand in the meantime is simply not there to
 *    remove, and that is fine.
 *
 * ORDER, so a crash between steps fails safe. On approve the ledger is saved
 * BEFORE the settings write, and restored if the write is refused — so the
 * ledger can briefly claim a line the file lacks (removing it later is a
 * no-op), never the reverse (a line in the file nobody will take back). On
 * release the settings write comes first and the ledger drops the lines only
 * once it landed; a refused write keeps them held, and the next boot sweep
 * retries.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { editAllowList, readAllowList } from './settings-allow-file.ts';
import type { TaskStore } from './tasks.ts';

export const PERMISSION_GRANTS_FILENAME = 'permission-grants.json';

interface TaskGrant {
  itemId: string;
  /** Every line the card listed, in card order. */
  rules: string[];
  grantedAt: number;
  grantedBy: string;
}

interface Ledger {
  /** Line → the open tasks holding it. Only lines the SERVER added. */
  lines: Record<string, string[]>;
  tasks: Record<string, TaskGrant>;
}

export type GrantResult =
  | { ok: true; added: string[]; alreadyAllowed: string[] }
  | { ok: false; error: string; message: string };

export type ReleaseResult =
  | { ok: true; removed: string[] }
  | { ok: false; error: string; message: string };

export class PermissionGrants {
  private readonly ledgerPath: string;
  private ledger: Ledger = { lines: {}, tasks: {} };

  constructor(
    dataDir: string,
    /** The settings file this server may edit. Injected — see `bin.ts`. */
    private readonly settingsPath: string,
  ) {
    this.ledgerPath = join(dataDir, PERMISSION_GRANTS_FILENAME);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.ledgerPath)) return;
    const parsed = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Partial<Ledger>;
    this.ledger = { lines: parsed.lines ?? {}, tasks: parsed.tasks ?? {} };
  }

  private save(): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const tmp = `${this.ledgerPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.ledgerPath);
  }

  /** The lines each open task holds — read by tests and the security doc. */
  held(): { lines: Record<string, string[]>; tasks: string[] } {
    return {
      lines: structuredClone(this.ledger.lines),
      tasks: Object.keys(this.ledger.tasks),
    };
  }

  /** Write the card's lines for `taskId`, recording which ones the server added. */
  grant(
    taskId: string,
    itemId: string,
    rules: readonly string[],
    grantedBy: string,
    now: number,
  ): GrantResult {
    const current = readAllowList(this.settingsPath);
    if (!current.ok) return current;
    const before = structuredClone(this.ledger);
    const toAdd: string[] = [];
    const alreadyAllowed: string[] = [];
    for (const rule of rules) {
      const holders = this.ledger.lines[rule];
      const present = current.allow.includes(rule);
      if (holders) {
        // Ours already. Hold it for this task too; re-add it if a person
        // removed it by hand, because this task was just granted it.
        if (!holders.includes(taskId)) holders.push(taskId);
        if (!present) toAdd.push(rule);
      } else if (present) {
        // The owner's own line. Never recorded, so never removed.
        alreadyAllowed.push(rule);
      } else {
        this.ledger.lines[rule] = [taskId];
        toAdd.push(rule);
      }
    }
    this.ledger.tasks[taskId] = { itemId, rules: [...rules], grantedAt: now, grantedBy };
    this.save();
    const wrote = editAllowList(this.settingsPath, { add: toAdd });
    if (!wrote.ok) {
      this.ledger = before;
      this.save();
      return wrote;
    }
    return { ok: true, added: wrote.added, alreadyAllowed };
  }

  /**
   * Take back what `taskId` holds: every line whose last holder it was. A
   * task holding nothing is a no-op that writes nothing.
   */
  release(taskId: string): ReleaseResult {
    const lastHeld: string[] = [];
    let holdsAny = this.ledger.tasks[taskId] !== undefined;
    for (const [rule, holders] of Object.entries(this.ledger.lines)) {
      if (!holders.includes(taskId)) continue;
      holdsAny = true;
      if (holders.length === 1) lastHeld.push(rule);
    }
    if (!holdsAny) return { ok: true, removed: [] };
    const wrote = editAllowList(this.settingsPath, { remove: lastHeld });
    if (!wrote.ok) return wrote;
    for (const [rule, holders] of Object.entries(this.ledger.lines)) {
      const rest = holders.filter((t) => t !== taskId);
      if (rest.length === 0) delete this.ledger.lines[rule];
      else this.ledger.lines[rule] = rest;
    }
    delete this.ledger.tasks[taskId];
    this.save();
    return { ok: true, removed: wrote.removed };
  }

  /** Every task that holds a line, whether or not it is still open. */
  holders(): string[] {
    const all = new Set<string>(Object.keys(this.ledger.tasks));
    for (const holders of Object.values(this.ledger.lines)) for (const t of holders) all.add(t);
    return [...all];
  }
}

/** Closed means done, archived, or gone. A goal row never holds a grant. */
export function taskIsClosed(taskStore: TaskStore, taskId: string): boolean {
  const task = taskStore.getTask(taskId);
  return !task || task.status === 'done' || task.archivedAt !== undefined;
}

/**
 * Release on close, and once at boot for any close this process missed (the
 * server was down, or a release write was refused). Returns the unsubscribe.
 */
export function wirePermissionGrantRelease(
  taskStore: TaskStore,
  grants: PermissionGrants,
  onError: (taskId: string, message: string) => void,
): () => void {
  const release = (taskId: string): void => {
    const res = grants.release(taskId);
    if (!res.ok) onError(taskId, res.message);
  };
  for (const taskId of grants.holders()) {
    if (taskIsClosed(taskStore, taskId)) release(taskId);
  }
  return taskStore.onEvent((ev) => {
    if (ev.type === 'task.transitioned' && ev.to === 'done' && ev.kind !== 'goal') {
      release(ev.taskId);
    } else if (ev.type === 'task.archived') {
      release(ev.taskId);
    }
  });
}
