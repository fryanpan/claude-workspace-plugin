/**
 * Which spoken setup the planning voice's card (`doc-interview.ts`) talks
 * in: the one the board's switch last chose (`SETUP_KEY`) when this server
 * runs it, else the first it runs, and setup 1 or 2 for a meeting, which
 * setup 3 cannot hear because it listens with Gemini. Also the page's audio
 * context constructor, which Safari still names with a prefix.
 */
import { SPOKEN_SETUPS, type SpokenSetup } from '@claude-workspaces/core/spoken-reply';
import { SETUP_KEY } from '../board/spoken-reply-client.ts';

export function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** Setup 4 hands each turn to an agent session, which the interview never
 *  sees, so an interview runs on the other three. */
const INTERVIEW_SETUPS: readonly SpokenSetup[] = SPOKEN_SETUPS.filter((s) => s !== 4);

/** The board's chosen setup when this server runs it, else the first it runs. */
export function interviewSetup(
  setups: readonly SpokenSetup[],
  stored: string | null,
): SpokenSetup | null {
  const usable = INTERVIEW_SETUPS.filter((s) => setups.includes(s));
  const want = Number(stored);
  if (usable.includes(want as SpokenSetup)) return want as SpokenSetup;
  return usable[0] ?? null;
}

/** The card's setup, and the one a meeting is heard on. `storage`
 *  undefined: the page's own. */
export function interviewSetups(
  setups: readonly SpokenSetup[],
  storage: Pick<Storage, 'getItem'> | null | undefined,
): { setup: SpokenSetup | null; earsSetup: SpokenSetup | null } {
  const store =
    storage === undefined
      ? (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })()
      : storage;
  const stored = (() => {
    try {
      return store?.getItem(SETUP_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  const setup = interviewSetup(setups, stored);
  const earsSetup: SpokenSetup | null =
    setup === 1 || setup === 2
      ? setup
      : (([1, 2] as const).find((s) => setups.includes(s)) ?? null);
  return { setup, earsSetup };
}
