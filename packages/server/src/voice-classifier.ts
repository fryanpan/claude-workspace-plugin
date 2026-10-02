/**
 * The router's one model step, as a seam another router can be put behind.
 *
 * `VoiceRouter.handle` answers what it can with no model, and asks a
 * classifier only for what is left: change or lookup, which target, which of
 * the scoped verbs. Everything after the classification — the guardrail
 * (`voice-action.ts`), the id validation, the executors — is the router's,
 * whichever classifier answered, so swapping one changes what is DECIDED and
 * never what may be WRITTEN.
 *
 * `jsonClassifier` is the shipped one: the prompt in `voice-prompt.ts`, one
 * completion, and `parseVoiceReply`. The alternatives the router eval scores
 * (`scripts/voice-router-eval.ts`) live in `voice-choice.ts`.
 */
import {
  type VoiceClassification,
  type VoiceContext,
  type VoiceResource,
  buildVoicePrompt,
  parseVoiceReply,
} from './voice-prompt.ts';

/** One completion round trip: prompt in, raw reply text out. */
export type VoiceComplete = (args: { system: string; user: string }) => Promise<string>;

/** The board as the classifier is shown it. */
export interface VoiceIndex {
  goals: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string; title: string; status: string; needs?: string }>;
  docIds: string[];
  docTitles?: Record<string, string>;
  /** The speaker's other boards, for "take me to the Riverbend board". */
  boards?: Array<{ id: string; name: string }>;
}

export interface VoiceClassifyInput {
  index: VoiceIndex;
  transcript: string;
  context?: VoiceContext;
  resource?: VoiceResource;
  /** The settings page's override of the shipped system prompt. */
  instructions?: string;
}

export interface VoiceClassified {
  /** Null: the reply could not be read — the router reports the fast path down. */
  classification: VoiceClassification | null;
  /** The classifier's own probability for its pick, when it gives one. */
  confidence?: number;
}

export type VoiceClassifier = (input: VoiceClassifyInput) => Promise<VoiceClassified>;

/** The shipped classifier: one JSON-shaped completion. */
export function jsonClassifier(complete: VoiceComplete): VoiceClassifier {
  return async ({ index, transcript, context, resource, instructions }) => {
    const reply = await complete(
      buildVoicePrompt(index, transcript, context, resource, instructions),
    );
    return { classification: parseVoiceReply(reply) };
  };
}
