/**
 * Whether a meeting frame heard after the pause is somebody speaking — the
 * test that keeps the planning voice from talking over a meeting.
 *
 * Bryan's first planning meeting: the pause held, the plan was read, and the
 * question started about a second after the pause while he had already gone
 * on ("I noticed that there's— Oh, that was really disruptive"). Nothing was
 * listening between the pause and the end of the question, so nothing could
 * know. Now a socket hearing a meeting keeps hearing it after the pause
 * (`session.ts`), and a frame with words in it stops the voice.
 *
 * Except the voice's own words. The page plays the question out of the
 * speaker the meeting's microphone is listening beside, and whatever echo
 * cancellation the browser does is not something to bet the voice on. A
 * frame whose words are mostly the words being said is the room hearing the
 * voice, and is not a cut-in.
 */

/** The share of a frame's words found in what the voice is saying, at or
 *  above which the frame is taken for the voice's own echo. */
export const ECHO_SHARE = 0.6;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Whether `heard` carries any word at all, not only punctuation. */
export function hasWords(heard: string): boolean {
  return words(heard).length > 0;
}

/** Whether `heard` is the room hearing `saying` played back. */
export function echoOf(heard: string, saying: string): boolean {
  const said = new Set(words(saying));
  const got = words(heard);
  if (said.size === 0 || got.length === 0) return false;
  return got.filter((w) => said.has(w)).length / got.length >= ECHO_SHARE;
}

/** A frame heard while the voice answers is the speaker going on. */
export function cutsIn(heard: string, saying: string): boolean {
  return hasWords(heard) && !echoOf(heard, saying);
}
