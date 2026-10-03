/** What `math-browser-driver.ts` prints and `math-browser.test.ts` asserts.
 *  Its own file so the test imports nothing that reads source. */
export interface Reading {
  /** After the doc without math. */
  before: { katex: number; requests: number; resources: number; stylesheets: number };
  /** After the doc with math. */
  after: {
    katex: number;
    display: number;
    requests: string[];
    scriptLinks: number;
    errors: number;
    errorText: string;
    openedOnClick: string;
  };
}
