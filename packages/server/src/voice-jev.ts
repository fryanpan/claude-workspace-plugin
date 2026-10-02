import {
  CHOICE_DEFINITIONS,
  CHOICE_QUESTION,
  type VoiceChoiceOption,
  choiceSituation,
  classificationFor,
  voiceChoices,
} from './voice-choice.ts';
/**
 * The router's choice question (`voice-choice.ts`) asked of TypeSafe's Jev,
 * a model that picks one option from a set and gives a probability for each.
 *
 * NOT CALLED. Sending workspace text to TypeSafe waits on the owner's
 * decision, so this file holds no address, reads no key and opens no socket:
 * the transport is a parameter, and nothing in the repo passes one that
 * reaches the vendor. The router eval refuses this arm until it does.
 *
 * THE WIRE SHAPE IS ASSUMED, not recorded: one choice question, options as
 * `{ id, label }`, a definitions block, the situation and utterance as the
 * input, and a reply naming the choice with a probability per option. When
 * a recorded exchange exists, `buildJevRequest` and `parseJevResponse` are
 * the two functions to bring into line with it, and the fixture in
 * `voice-jev.test.ts` is the one to replace.
 */
import type { VoiceClassified, VoiceClassifyInput } from './voice-classifier.ts';
import { promptSafe } from './voice-prompt.ts';

export interface JevRequest {
  question: {
    type: 'choice';
    prompt: string;
    options: Array<{ id: string; label: string }>;
    definitions: string;
  };
  input: string;
}

export interface JevPick {
  id?: string;
  /** The picked option's probability. */
  confidence?: number;
  /** Every option's probability, as returned. */
  probabilities: Record<string, number>;
}

/** Sends one request, answers the parsed JSON body. Injected; see the header. */
export type JevTransport = (request: JevRequest) => Promise<unknown>;

export function buildJevRequest(
  input: VoiceClassifyInput,
  options: readonly VoiceChoiceOption[],
): JevRequest {
  return {
    question: {
      type: 'choice',
      prompt: CHOICE_QUESTION,
      options: options.map((o) => ({ id: o.id, label: o.label })),
      definitions: CHOICE_DEFINITIONS.join('\n'),
    },
    input: `${choiceSituation(input)}\nThe speaker said: "${promptSafe(input.transcript, 2000)}"`,
  };
}

/** The pick out of a reply; a malformed one picks nothing. */
export function parseJevResponse(body: unknown): JevPick {
  if (typeof body !== 'object' || body === null) return { probabilities: {} };
  const b = body as Record<string, unknown>;
  const probabilities: Record<string, number> = {};
  const raw = b.probabilities;
  if (typeof raw === 'object' && raw !== null) {
    for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof p === 'number' && p >= 0 && p <= 1) probabilities[id] = p;
    }
  }
  const id = typeof b.choice === 'string' ? b.choice : undefined;
  const confidence = id !== undefined ? probabilities[id] : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    probabilities,
  };
}

export function jevClassifier(transport: JevTransport) {
  return async (input: VoiceClassifyInput): Promise<VoiceClassified> => {
    const options = voiceChoices(input);
    const pick = parseJevResponse(await transport(buildJevRequest(input, options)));
    return {
      classification: classificationFor(options, pick.id),
      ...(pick.confidence !== undefined ? { confidence: pick.confidence } : {}),
    };
  };
}
