#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The version line of `packages/core/src/plot-spec.mjs`, the file other sites
 * copy verbatim. Its first line names a version and the sha256 of every byte
 * after that line, so any change to the contents changes the line a site
 * compares. A site with no tooling checks a copy with
 * `tail -n +2 plot-spec.mjs | shasum -a 256`: the digest starts with the hash
 * the line names.
 *
 *   bun run plot-spec:stamp          rewrite the line after an edit
 *   bun run plot-spec:stamp --check  exit 1 when the line no longer matches
 *
 * Stamping bumps the version once per change against origin/main: when the
 * contents differ from main's and the version is still main's, it takes the
 * next number and today's date, in the line and in `PLOT_SPEC_VERSION`.
 * Stamping again on the same branch keeps that number.
 */

export const PLOT_SPEC_PATH = join(import.meta.dirname, '..', 'packages/core/src/plot-spec.mjs');
const REPO_PATH = 'packages/core/src/plot-spec.mjs';

const LINE = /Version (\d+) \((\d{4}-\d{2}-\d{2}), sha256 ([0-9a-f]{16})\)/;
const CONSTANT = /export const PLOT_SPEC_VERSION = (\d+);/;

/** The first 16 hex digits of the sha256 of `body`. */
export const bodyHash = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);

function split(text: string): { header: string; body: string } {
  const nl = text.indexOf('\n');
  return nl < 0
    ? { header: text, body: '' }
    : { header: text.slice(0, nl), body: text.slice(nl + 1) };
}

const headerLine = (version: number, date: string, hash: string): string =>
  `// plot-spec.mjs: the canonical copy, in claude-workspaces packages/core/src. Version ${version} (${date}, sha256 ${hash}). Other repos copy these bytes verbatim and compare this line; \`tail -n +2\` of the file hashes to that sha256 prefix.`;

export interface StampVerdict {
  ok: boolean;
  version?: number;
  reason?: string;
}

/** Whether `text`'s first line names its own version and the hash of the rest. */
export function stampVerdict(text: string): StampVerdict {
  const { header, body } = split(text);
  const m = LINE.exec(header);
  if (!m) return { ok: false, reason: 'the first line names no "Version N (date, sha256 …)"' };
  const version = Number(m[1]);
  const actual = bodyHash(body);
  if (m[3] !== actual) {
    return {
      ok: false,
      version,
      reason: `the contents hash to ${actual}, not ${m[3]}: run \`bun run plot-spec:stamp\``,
    };
  }
  const constant = CONSTANT.exec(body);
  if (Number(constant?.[1]) !== version) {
    return { ok: false, version, reason: `PLOT_SPEC_VERSION is not ${version}` };
  }
  return { ok: true, version };
}

/** The stamp verdict on the file at `path`. */
export const checkFile = (path: string): StampVerdict => stampVerdict(readFileSync(path, 'utf8'));

/** A version written in a first line, old form or new. */
const versionIn = (header: string): number => Number(/Version (\d+)/.exec(header)?.[1] ?? 0);

/**
 * `text` with its first line rewritten. `base` is the released copy: when the
 * contents differ from it and the version is not past its, the version moves
 * on by one and the date becomes `today`.
 */
export function stamped(text: string, base: string | undefined, today: string): string {
  const { header, body } = split(text);
  const old = LINE.exec(header);
  let version = versionIn(header);
  let date = old?.[2] ?? today;
  if (base !== undefined) {
    const released = split(base);
    const baseVersion = versionIn(released.header);
    const same = (b: string) => b.replace(CONSTANT, '') === released.body.replace(CONSTANT, '');
    if (!same(body) && version <= baseVersion) {
      version = baseVersion + 1;
      date = today;
    }
  }
  const next = body.replace(CONSTANT, `export const PLOT_SPEC_VERSION = ${version};`);
  return `${headerLine(version, date, bodyHash(next))}\n${next}`;
}

/** Restamp the file at `path` against the released copy at `basePath`. */
export function stampFile(path: string, basePath: string | undefined, today: string): StampVerdict {
  const base = basePath === undefined ? undefined : readFileSync(basePath, 'utf8');
  writeFileSync(path, stamped(readFileSync(path, 'utf8'), base, today));
  return checkFile(path);
}

function mainCopy(): string | undefined {
  try {
    return execFileSync('git', ['show', `origin/main:${REPO_PATH}`], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const verdict = checkFile(PLOT_SPEC_PATH);
    console.log(
      verdict.ok ? `plot-spec.mjs version ${verdict.version}: stamp matches` : verdict.reason,
    );
    process.exit(verdict.ok ? 0 : 1);
  }
  const base = mainCopy();
  if (base === undefined) console.warn('origin/main has no plot-spec.mjs to compare: version kept');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(PLOT_SPEC_PATH, stamped(readFileSync(PLOT_SPEC_PATH, 'utf8'), base, today));
  const verdict = checkFile(PLOT_SPEC_PATH);
  console.log(`plot-spec.mjs stamped as version ${verdict.version}`);
}
