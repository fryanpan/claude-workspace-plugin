/**
 * The grant ledger: which lines the server added, who holds each, and taking
 * back exactly those. Every settings file here is in a temp dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionGrants, wirePermissionGrantRelease } from '../src/permission-grants.ts';
import type { TaskStore, TaskStoreEvent } from '../src/tasks.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PUSH = 'Bash(git push --force-with-lease:*)';
const TAG = 'Bash(git tag:*)';
const OWN = 'Bash(git status:*)';

/** A data dir and a settings file already holding one line of the owner's. */
function setup(): { dataDir: string; settings: string; original: string } {
  const root = mkdtempSync(join(tmpdir(), 'permission-grants-'));
  dirs.push(root);
  const settings = join(root, 'settings.json');
  const original = `${JSON.stringify(
    { permissions: { allow: [OWN], deny: ['Bash(rm -rf:*)'] }, model: 'saltmarsh' },
    null,
    2,
  )}\n`;
  writeFileSync(settings, original);
  return { dataDir: join(root, 'data'), settings, original };
}

const allowOf = (settings: string): string[] =>
  JSON.parse(readFileSync(settings, 'utf8')).permissions.allow;

describe('granting a card', () => {
  it('adds exactly the lines not already allowed, and records only those', () => {
    const { dataDir, settings } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    const res = grants.grant('t-harbor', 'r-1', [PUSH, OWN], 'user-owner', 1);
    expect(res).toEqual({ ok: true, added: [PUSH], alreadyAllowed: [OWN] });
    expect(allowOf(settings)).toEqual([OWN, PUSH]);
    // The owner's own line is never entered in the ledger.
    expect(grants.held().lines).toEqual({ [PUSH]: ['t-harbor'] });
  });

  it('survives a restart: a new instance reads the same ledger', () => {
    const { dataDir, settings } = setup();
    new PermissionGrants(dataDir, settings).grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    expect(new PermissionGrants(dataDir, settings).held().lines).toEqual({
      [PUSH]: ['t-harbor'],
    });
  });

  it('writes nothing and records nothing when the file does not parse', () => {
    const { dataDir, settings } = setup();
    writeFileSync(settings, '{ not json');
    const grants = new PermissionGrants(dataDir, settings);
    const res = grants.grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    expect(res.ok).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe('{ not json');
    expect(grants.held()).toEqual({ lines: {}, tasks: [] });
  });
});

describe('releasing on close', () => {
  it('removes the lines the task added and leaves every other byte', () => {
    const { dataDir, settings, original } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    grants.grant('t-harbor', 'r-1', [PUSH, TAG, OWN], 'u', 1);
    expect(grants.release('t-harbor')).toEqual({ ok: true, removed: [PUSH, TAG] });
    expect(readFileSync(settings, 'utf8')).toBe(original);
    expect(grants.held()).toEqual({ lines: {}, tasks: [] });
  });

  it('keeps a line two open tasks share until the last one closes', () => {
    const { dataDir, settings } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    grants.grant('t-harbor', 'r-1', [PUSH, TAG], 'u', 1);
    const second = grants.grant('t-river', 'r-2', [PUSH], 'u', 2);
    // Already ours, so nothing new is written for the second task.
    expect(second).toEqual({ ok: true, added: [], alreadyAllowed: [] });
    expect(grants.release('t-harbor')).toEqual({ ok: true, removed: [TAG] });
    expect(allowOf(settings)).toEqual([OWN, PUSH]);
    expect(grants.release('t-river')).toEqual({ ok: true, removed: [PUSH] });
    expect(allowOf(settings)).toEqual([OWN]);
  });

  it('is fine when a person already removed the line by hand', () => {
    const { dataDir, settings } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    grants.grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    const edited = JSON.parse(readFileSync(settings, 'utf8'));
    edited.permissions.allow = [OWN];
    writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`);
    expect(grants.release('t-harbor')).toEqual({ ok: true, removed: [] });
    expect(grants.held()).toEqual({ lines: {}, tasks: [] });
  });

  it('keeps holding the lines when the release write is refused, so a retry can finish', () => {
    const { dataDir, settings } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    grants.grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    const good = readFileSync(settings, 'utf8');
    writeFileSync(settings, '{ broken');
    expect(grants.release('t-harbor').ok).toBe(false);
    expect(grants.held().lines).toEqual({ [PUSH]: ['t-harbor'] });
    writeFileSync(settings, good);
    expect(grants.release('t-harbor')).toEqual({ ok: true, removed: [PUSH] });
  });

  it('a task that holds nothing releases nothing and writes nothing', () => {
    const { dataDir, settings, original } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    expect(grants.release('t-never')).toEqual({ ok: true, removed: [] });
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });
});

describe('the close wiring', () => {
  /** The two reads the wiring makes of a store, and a way to fire events. */
  function fakeStore(statuses: Record<string, { status: string; archivedAt?: number }>) {
    let listener: ((ev: TaskStoreEvent) => void) | undefined;
    const store = {
      getTask: (id: string) => statuses[id],
      onEvent: (fn: (ev: TaskStoreEvent) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as TaskStore;
    return { store, fire: (ev: Record<string, unknown>) => listener?.(ev as TaskStoreEvent) };
  }

  it('releases on done and on archive, not on another move', () => {
    const { dataDir, settings } = setup();
    const grants = new PermissionGrants(dataDir, settings);
    grants.grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    grants.grant('t-river', 'r-2', [TAG], 'u', 1);
    const { store, fire } = fakeStore({
      't-harbor': { status: 'in-progress' },
      't-river': { status: 'in-progress' },
    });
    wirePermissionGrantRelease(store, grants, () => undefined);
    fire({ type: 'task.transitioned', taskId: 't-harbor', from: 'todo', to: 'in-progress' });
    expect(allowOf(settings)).toEqual([OWN, PUSH, TAG]);
    fire({ type: 'task.transitioned', taskId: 't-harbor', from: 'in-progress', to: 'done' });
    expect(allowOf(settings)).toEqual([OWN, TAG]);
    fire({ type: 'task.archived', taskId: 't-river' });
    expect(allowOf(settings)).toEqual([OWN]);
  });

  it('at boot, releases a task that closed while the server was down', () => {
    const { dataDir, settings } = setup();
    new PermissionGrants(dataDir, settings).grant('t-harbor', 'r-1', [PUSH], 'u', 1);
    new PermissionGrants(dataDir, settings).grant('t-river', 'r-2', [TAG], 'u', 1);
    const { store } = fakeStore({
      't-harbor': { status: 'done' },
      't-river': { status: 'in-progress' },
    });
    wirePermissionGrantRelease(store, new PermissionGrants(dataDir, settings), () => undefined);
    expect(allowOf(settings)).toEqual([OWN, TAG]);
  });
});
