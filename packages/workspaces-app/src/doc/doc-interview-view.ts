/**
 * What the planning voice looks like on the review doc: a Talk button above
 * the voice-comment mic, and a card above it holding the question Claude
 * asked, the words heard so far and the three commands as buttons.
 *
 * Calm, as the board's reply panel is: one steady dot names the state (red
 * while listening, filled blue while Claude asks, a blue ring while it
 * writes), nothing pulses, and nothing moves as the state changes — the state
 * label and the main button are sized for their widest words, the commands
 * keep their slots when disabled, and the card keeps one height while its
 * body scrolls.
 */

export type InterviewPhase = 'idle' | 'listening' | 'thinking' | 'asking' | 'done';

export const PHASE_LABELS: Record<InterviewPhase, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Writing',
  asking: 'Asking you',
  done: 'Done',
};

/** The main button's word per phase. */
export const PRIMARY_LABELS: Record<InterviewPhase, string> = {
  idle: 'Talk',
  listening: 'Done',
  thinking: 'Talk',
  asking: 'Answer',
  done: 'Talk',
};

export const START_PROMPT =
  'Talk through the plan. When you pause, Claude asks what is still open.';

/** The same card, opened by a planning meeting rather than a tap. */
export const MEETING_PROMPT =
  'Claude is listening to the meeting. When you pause, it asks what is still open.';

/** The spoken commands, as buttons: label, then what tapping one says. */
export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['Skip', 'skip'],
  ['Later', 'come back to that'],
  ['Finish', 'that’s enough'],
];

export interface InterviewFrame {
  open: boolean;
  phase: InterviewPhase;
  /** What Claude asked or said last; the start prompt before anything. */
  question: string;
  heard: string;
  detail: readonly string[];
  note: string | null;
  /** An interview is running, so the commands apply. */
  interviewing: boolean;
}

export class DocInterviewView {
  readonly button: HTMLButtonElement;
  readonly card: HTMLDivElement;
  readonly primary: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly commands: HTMLButtonElement[];

  constructor(doc: Document = document) {
    this.button = doc.createElement('button');
    this.button.type = 'button';
    this.button.className = 'doc-interview-btn';
    this.button.textContent = 'Talk';
    this.button.title = 'Talk through this plan; Claude asks what is still open when you pause';
    this.card = doc.createElement('div');
    this.card.className = 'doc-interview';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', 'Talk through the plan');
    this.card.innerHTML =
      '<div class="doc-interview-head"><span class="doc-interview-dot"></span>' +
      '<span class="doc-interview-state" aria-live="polite"></span>' +
      '<button class="doc-interview-close" type="button" aria-label="Stop talking">×</button></div>' +
      '<div class="doc-interview-body"><p class="doc-interview-question"></p>' +
      '<p class="doc-interview-you"></p><ul class="doc-interview-detail"></ul>' +
      '<p class="doc-interview-note"></p></div>' +
      '<div class="doc-interview-foot"><button class="doc-interview-primary" type="button"></button>' +
      COMMANDS.map(
        ([label, say]) =>
          `<button class="doc-interview-cmd" type="button" data-say="${say}">${label}</button>`,
      ).join('') +
      '</div>';
    this.primary = this.part('.doc-interview-primary') as HTMLButtonElement;
    this.close = this.part('.doc-interview-close') as HTMLButtonElement;
    this.commands = Array.from(this.card.querySelectorAll<HTMLButtonElement>('.doc-interview-cmd'));
    doc.body.append(this.card, this.button);
  }

  private part(sel: string): HTMLElement {
    return this.card.querySelector(sel) as HTMLElement;
  }

  draw(f: InterviewFrame): void {
    this.card.hidden = !f.open;
    this.card.dataset.phase = f.phase;
    this.button.setAttribute('aria-pressed', String(f.open));
    this.button.classList.toggle('on', f.open);
    this.part('.doc-interview-state').textContent = PHASE_LABELS[f.phase];
    this.part('.doc-interview-question').textContent = f.question;
    const you = this.part('.doc-interview-you');
    you.textContent = f.heard ? `You: ${f.heard}` : '';
    const detail = this.part('.doc-interview-detail');
    detail.replaceChildren(
      ...f.detail.map((line) => {
        const li = this.card.ownerDocument.createElement('li');
        li.textContent = line;
        return li;
      }),
    );
    this.part('.doc-interview-note').textContent = f.note ?? '';
    this.primary.textContent = PRIMARY_LABELS[f.phase];
    this.primary.disabled = f.phase === 'thinking';
    for (const b of this.commands) b.disabled = !f.interviewing || f.phase === 'thinking';
  }

  remove(): void {
    this.card.remove();
    this.button.remove();
  }
}
