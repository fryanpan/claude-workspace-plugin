/**
 * The review queue by voice: "go through my reviews", and Claude reads each
 * item's headline and options aloud, answers questions about it, and reads
 * the decision back before it is recorded.
 *
 * One walk per socket, holding the queue as it stood when the walk started
 * and re-checking each item against the live queue before reading it, so an
 * item answered on the screen meanwhile is passed over rather than answered
 * twice. Items the rule in `review-speakable.ts` keeps for the screen are
 * counted aloud and never read.
 *
 * NOTHING IS RECORDED UNTIL A YES. A pick or an answer moves the walk to a
 * read-back, and only a yes produces a `decide` for the page to write,
 * through the same route the screen's answer button uses. The read-back, the
 * yes and the one-utterance undo window are `confirm.ts`; an undo goes back
 * to the item it took back.
 */
import type { SpokenDecide, SpokenPoint } from '@claude-workspaces/core/spoken-reply';
import { SPOKEN_MAX_WORDS } from '@claude-workspaces/core/spoken-reply';
import type { ReviewItemRow } from '../review-queue.ts';
import { parseOrdinal, pickByLabel } from '../voice-resolve.ts';
import { capWords } from '../voice-status.ts';
import { Confirm, type Proposal, READ_BACK_CHOICES } from './confirm.ts';
import { type WalkItem, splitQueue } from './review-speakable.ts';
import { asksAbout, normalize, repeats, skips, startsWalk, stops } from './review-words.ts';

export interface WalkReply {
  spoken: string;
  points: SpokenPoint[];
  detail: string[];
  asking: boolean;
  choices?: string[];
  decide?: SpokenDecide;
}

export interface ReviewWalkDeps {
  /** The board's review queue as the Home tab shows it, read fresh. */
  queue(): readonly ReviewItemRow[];
  /** One model call, prompt in and text out — answers a question about an
   *  item. Absent: the item's own detail is read instead. */
  explain?: (args: { system: string; user: string }) => Promise<string>;
}

const EXPLAIN_SYSTEM = [
  'You answer a spoken question about one review item on a work board.',
  'Use only the item text given. Answer in at most two short sentences of plain speech:',
  'no lists, no markdown, no links. If the text does not say, say so in one sentence.',
].join(' ');

const NUMBERS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

function count(n: number): string {
  return NUMBERS[n] ?? String(n);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function listOr(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** Markdown down to the words a voice can say. */
function plainWords(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function reply(parts: string[], extra: Partial<WalkReply> = {}): WalkReply {
  const says = parts.map((p) => p.trim()).filter(Boolean);
  return {
    spoken: says.join(' '),
    points: says.map((say) => ({ say })),
    detail: [],
    asking: false,
    ...extra,
  };
}

export class ReviewWalk {
  private items: WalkItem[] = [];
  private screen = 0;
  private at = 0;
  /** False when no walk is running. */
  private walking = false;
  private confirm = new Confirm<WalkItem>();

  constructor(private readonly deps: ReviewWalkDeps) {}

  get active(): boolean {
    return this.walking || this.confirm.undoable;
  }

  /** The walk's answer to what was heard, or null when it is not the walk's. */
  async hear(heard: string): Promise<WalkReply | null> {
    const recorded = this.confirm.takeBack(heard);
    if (recorded) return this.undo(recorded);
    if (!this.walking) return startsWalk(heard) ? this.start() : null;
    if (startsWalk(heard)) return this.start();
    const item = this.current();
    if (!item) return this.finish([]);
    if (this.confirm.confirming) return this.confirming(item, heard);
    return this.deciding(item, heard);
  }

  /** The page's report on a write. Null when there is nothing to say. */
  decided(id: string, ok: boolean): WalkReply | null {
    const sent = this.confirm.settled(id, ok);
    if (!sent) return null;
    const headline = sent.subject.headline;
    return sent.action === 'record'
      ? reply([`That one didn’t go through, so “${headline}” is still on your queue.`])
      : reply([`Taking that back didn’t go through, so the answer on “${headline}” stands.`]);
  }

  private start(): WalkReply {
    const { items, screen } = splitQueue(this.deps.queue());
    this.items = items;
    this.screen = screen;
    this.at = 0;
    this.confirm.reset();
    if (items.length === 0) {
      this.walking = false;
      return reply([
        screen > 0
          ? `Nothing I can read out: ${count(screen)} ${screen === 1 ? 'needs' : 'need'} the screen.`
          : 'Your review queue is empty.',
      ]);
    }
    this.walking = true;
    const first = this.current();
    if (!first) return this.finish([]);
    const lead = `${capital(count(items.length))} to go through${
      screen > 0 ? `, and ${count(screen)} ${screen === 1 ? 'needs' : 'need'} the screen` : ''
    }.`;
    return this.present(first, [lead], 'First');
  }

  /** The item at the cursor, passing over any no longer on the live queue. */
  private current(): WalkItem | undefined {
    const live = new Set(splitQueue(this.deps.queue()).items.map((i) => i.key));
    while (this.at < this.items.length && !live.has(this.items[this.at]?.key ?? '')) this.at++;
    return this.items[this.at];
  }

  private present(item: WalkItem, lead: string[], label?: 'First' | 'Next'): WalkReply {
    this.walking = true;
    const labels = item.options.map((o) => o.label);
    const ask = labels.length > 0 ? `${listOr(labels)}?` : 'What’s your answer?';
    const headline = sentence(label ? `${label}: ${item.headline}` : item.headline);
    return reply([...lead, headline, ask], {
      asking: true,
      detail: [`On ${item.title}, from ${item.askedBy}.`, 'Ask about it, skip it, or say stop.'],
      ...(labels.length > 0 ? { choices: labels } : {}),
    });
  }

  private finish(lead: string[]): WalkReply {
    this.walking = false;
    const left = this.items.length - this.at;
    const parts = [...lead];
    if (left > 0) parts.push(`Stopped, with ${count(left)} still to go.`);
    else parts.push('That’s all I can read out.');
    if (this.screen > 0) {
      parts.push(
        `${capital(count(this.screen))} ${this.screen === 1 ? 'needs' : 'need'} the screen.`,
      );
    }
    return reply(parts);
  }

  private next(lead: string[]): WalkReply {
    this.at++;
    const item = this.current();
    if (!item) {
      this.at = this.items.length;
      return this.finish(lead);
    }
    return this.present(item, lead, 'Next');
  }

  private deciding(item: WalkItem, heard: string): WalkReply | Promise<WalkReply> {
    if (stops(heard)) return this.finish([]);
    if (skips(heard)) return this.next(['Left on your queue.']);
    if (repeats(heard)) return this.present(item, []);
    const picked = this.pick(item, heard);
    if (picked) return this.readBack(picked);
    if (asksAbout(heard)) return this.explain(item, heard);
    if (item.options.length === 0) return this.readBack({ text: heard.trim() });
    return reply([`I didn’t catch which. ${listOr(item.options.map((o) => o.label))}?`], {
      asking: true,
      choices: item.options.map((o) => o.label),
    });
  }

  private confirming(item: WalkItem, heard: string): WalkReply {
    const verdict = this.confirm.judge(heard, (said) => this.pick(item, said));
    switch (verdict.kind) {
      case 'yes':
        return this.record(item, verdict.proposal);
      case 'stop':
        return this.finish(['Not recorded.']);
      case 'other':
        return this.readBack(verdict.proposal);
      case 'no':
        return this.present(item, ['Not recorded.']);
      case 'unclear':
        return reply(verdict.say, { asking: true, choices: [...READ_BACK_CHOICES] });
    }
  }

  /** An option named by position, by its label, or by its label's words
   *  opening what was said ("approve the mock" → Approve). */
  private pick(item: WalkItem, heard: string): Proposal | null {
    const options = item.options;
    if (options.length === 0 || !heard.trim()) return null;
    const at = parseOrdinal(heard, options.length);
    const hit =
      (at !== null ? options[at] : undefined) ??
      pickByLabel(heard, options) ??
      (() => {
        const s = normalize(heard);
        const opening = options.filter((o) => {
          const label = normalize(o.label);
          return label !== '' && (s === label || s.startsWith(`${label} `));
        });
        return opening.length === 1 ? opening[0] : undefined;
      })();
    return hit ? { text: hit.label, optionId: hit.id } : null;
  }

  private readBack(choice: Proposal): WalkReply {
    return reply(this.confirm.propose(choice), {
      asking: true,
      choices: [...READ_BACK_CHOICES],
    });
  }

  private record(item: WalkItem, choice: Proposal): WalkReply {
    const id = this.confirm.commit(item);
    const decide: SpokenDecide = {
      id,
      action: 'record',
      target: item.target,
      text: choice.text,
      ...(choice.optionId !== undefined ? { optionId: choice.optionId } : {}),
    };
    return { ...this.next(['Recorded.']), decide };
  }

  private undo({ id, subject }: { id: string; subject: WalkItem }): WalkReply {
    const decide: SpokenDecide = { id, action: 'undo', target: subject.target };
    const index = this.items.indexOf(subject);
    this.at = index >= 0 ? index : this.at;
    return { ...this.present(subject, ['Taken back, so nothing is recorded.']), decide };
  }

  private async explain(item: WalkItem, question: string): Promise<WalkReply> {
    let said = '';
    if (this.deps.explain) {
      const options = item.options.map((o) => `- ${o.label}`).join('\n');
      try {
        said = await this.deps.explain({
          system: EXPLAIN_SYSTEM,
          user: [
            `Item: ${item.headline}`,
            `About: ${item.title}`,
            `Asked by: ${item.askedBy}`,
            item.detail ? `Detail:\n${item.detail}` : 'Detail: (none)',
            options ? `Options:\n${options}` : '',
            `Question: ${question}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      } catch {
        said = '';
      }
    }
    said = capWords(plainWords(said), SPOKEN_MAX_WORDS);
    if (!said) {
      const detail = plainWords(item.detail);
      said = detail
        ? capWords(detail, SPOKEN_MAX_WORDS)
        : 'It says nothing more than the headline.';
    }
    const labels = item.options.map((o) => o.label);
    return reply([said, labels.length > 0 ? `${listOr(labels)}?` : 'What’s your answer?'], {
      asking: true,
      ...(labels.length > 0 ? { choices: labels } : {}),
    });
  }
}
