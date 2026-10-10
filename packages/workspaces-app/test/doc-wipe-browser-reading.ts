/** One gesture's reading from `doc-wipe-browser-driver.ts`. */
export interface WipeReading {
  name: string;
  /** The doc's text length before the gesture, and after the key. */
  before: number;
  after: number;
  /** The editor's selection when the key went down. */
  selection: string;
}
