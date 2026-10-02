#!/usr/bin/env bun
/**
 * Does a voice note get its clarifying question only when it needs one?
 *
 * Runs the real tidy prompt over the labelled sample notes in
 * `fixtures/voice-ask/notes.json` — clear ones, ones whose element is
 * ambiguous (two Save buttons, two done chips) and ones whose meaning is —
 * and puts each reply through the same rule the relay applies
 * (`voice-feedback-ask.ts`). Prints asked / not asked against the labels.
 *
 * It spends the EVAL credential only (`eval-credential.ts`): one short call
 * per note, sixteen notes. `--record` writes the replies beside the fixture,
 * so `voice-ask-replay.test.ts` can check the rule on them with no call.
 *
 *   bun run scripts/voice-ask-eval.ts [--record]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceTarget } from '../packages/core/src/voice-feedback.ts';
import { withoutProdMarker } from '../packages/server/src/claude-key-source.ts';
import { askVerdictFor } from '../packages/server/src/voice-feedback-question.ts';
import {
  TIDY_MODEL,
  type TidyInput,
  buildTidyPrompt,
  createHaikuTidy,
  tidyDollars,
} from '../packages/server/src/voice-feedback-tidy.ts';
import { EVAL_CREDENTIAL_HELP } from './eval-credential.ts';

interface Note {
  id: string;
  words: string;
  pinned?: number;
  ask: boolean;
  about?: 'anchor' | 'meaning';
}

const dir = join(import.meta.dir, 'fixtures/voice-ask');
const fixture = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')) as {
  targets: VoiceTarget[];
  notes: Note[];
};

const complete = createHaikuTidy({ env: withoutProdMarker(process.env) });
if (!complete) {
  console.error(EVAL_CREDENTIAL_HELP);
  process.exit(2);
}

console.log(`${fixture.notes.length} notes; model ${TIDY_MODEL}`);
const replies: Record<string, string> = {};
let usd = 0;
const rows: Array<{ note: Note; asked: boolean; why: string; question: string }> = [];
for (const note of fixture.notes) {
  const input: TidyInput = {
    targets: fixture.targets,
    open: null,
    words: note.words,
    ...(note.pinned !== undefined ? { pinned: note.pinned } : {}),
  };
  const reply = await complete(buildTidyPrompt(input));
  usd += tidyDollars(reply.usage);
  replies[note.id] = reply.text;
  const v = askVerdictFor(input, reply.text);
  rows.push({
    note,
    asked: v.ask !== null,
    why: v.ask ? v.ask.about : v.why,
    question: v.ask?.question ?? '',
  });
}

for (const r of rows) {
  const mark = r.asked === r.note.ask ? 'ok ' : 'MISS';
  console.log(
    `${mark} ${r.note.id.padEnd(18)} label=${r.note.ask ? 'ask' : 'no '} asked=${r.asked ? 'yes' : 'no '} (${r.why}) ${r.question}`,
  );
}
const count = (ask: boolean, asked: boolean) =>
  rows.filter((r) => r.note.ask === ask && r.asked === asked).length;
const needs = rows.filter((r) => r.note.ask).length;
const clear = rows.length - needs;
console.log('\n| label | asked | not asked | total |');
console.log('| --- | --- | --- | --- |');
console.log(`| needs a question | ${count(true, true)} | ${count(true, false)} | ${needs} |`);
console.log(`| clear | ${count(false, true)} | ${count(false, false)} | ${clear} |`);
console.log(`\n${rows.length} calls, $${usd.toFixed(4)}`);

if (process.argv.includes('--record')) {
  writeFileSync(join(dir, 'replies.json'), `${JSON.stringify(replies, null, 2)}\n`);
  console.log('recorded replies.json');
}
