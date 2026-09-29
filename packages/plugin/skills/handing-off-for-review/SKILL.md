---
name: handing-off-for-review
description: Use when about to file or revise a review item, or to post a link asking a person to look at or decide on work on a claude-workspaces board. This is the last step of building a mock, writing a doc, a data page or a PR round.
---

# Handing off for review

The reader acts on the item without asking you anything. Run these checks, in order, before you file.

## 1. Look for an earlier answer

Call `list_threads(docId: "task:<taskId>")`, and `list_threads` on the doc or mock under review. Resolved threads count.

- **Already answered:** act on the answer. Drop the question, cite the answer with a link to its thread, and report the done line `met` with the answer as proof.
- **Your own open item asks something similar:** use `revise_review_item` on it. Don't add a second item.

## 2. Open every link through the reader's route

**Copy each board link from a tool response** (`reviewUrl`, `threadUrl`, or the path `attach_mockup` returned). Board links are relative, inline and under `/workspaces/<workspaceId>/`. A mock's link is `…/mockups/<docId>`, never `/mockup/` or `…/docs/`.

**Open each one headless,** on the board's local address, for example `http://127.0.0.1:8787`:

- **A mock:** run `check-mock-render.mjs` from `claude-workspaces:building-a-mock`. It must exit 0.
- **Any other link (manual):** open it in a throwaway headless Chrome. The page must show what the link text names, not a sign-in, a 404 or an empty app shell. A status code proves nothing: a board page can answer 200 with an empty app shell. An external link, such as a screenshot or a PR, must load the named content.

**Don't file while a link is dead.** Fix the link, or take it out of the text first.

The board holds an item whose board link names a missing id or retired route, but not one with a blank page or dead external link.

## 3. File, with a proof on each done criterion

Call `report_done_when` for each line. Each proof's `url` is a link you opened in step 2. Then file the item with `add_review_item`, or as a `review` payload on a reply in the existing thread, or revise the existing item. Done criteria go in `doneWhen`, not in the item's text. For format, see "Asking for Help from Humans" and "Done When" in `claude-workspaces:working-in-a-workspace`.

## Red flags

| Thought | Reality |
| --- | --- |
| "The lead said file it and move on" | The checks take minutes. A dead link or a repeated question costs a whole round. |
| "curl returned 200" | A board page can answer 200 with an empty app shell. |
| "I'll use this repo's screenshot script" | The next repo may not have it. Use the shipped check, or a throwaway headless Chrome. |
| "The screenshot link probably works" | If you haven't opened it, treat it as dead. |
| "I'll type the mock's path" | Copy it from the tool response. |
