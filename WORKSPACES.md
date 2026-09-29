# Where docs go in this project

This project keeps its docs in the repo rather than in the workspace server's
data dir. `docs/` and `docs/meetings/` are mounted, so a file you write under
them shows on the board's Library page where anyone can read and comment on
it.

Read this before writing a new doc. When a kind of doc has no home here, make
the folder and add its row below in the same change.

## The roots

| Root | What it holds | In git? |
| --- | --- | --- |
| `docs/product/` | Vision, decisions, design notes | Committed |
| `docs/product/plans/` | Implementation plans | Ignored by default — see below |
| `docs/architecture/` | The overview, and one summary per subsystem | Committed |
| `docs/process/` | Delivery, retros, the learnings archive | Committed |
| `docs/proposals/` | A change being argued for, before it is agreed | Committed |
| `docs/research/` | A dated question somebody dug into | Ignored by default — see below |
| `docs/superpowers/specs/` | Dated design specs for a feature | Committed |
| `docs/meetings/` | Meeting notes and their records | Ignored |

## Plans and research are written in the open, not committed by default

This repo is public. Plans and research notes get written here while the work
is in flight, bound to a live review doc, and most of them never belong in the
history. So `.gitignore` holds `docs/product/plans/*.md` and
`docs/research/*.md`.

Those patterns untrack nothing. The plans and notes already in the repo stay
tracked and their changes stay visible; what the patterns stop is a
`git add -A` sweep that pulls in a draft naming another team's tickets.
Publishing a new one is a deliberate act: scrub it, then `git add -f <path>`.

## Meetings stay on the box

`docs/meetings/` carries a `.gitignore` holding `*`, written by the server
because this project chose to keep its meetings out of git. Delete that file
to commit them instead.

A meeting's raw record — `*-raw-transcript.md`, its `-replay-` reruns and the
`.pcm` audio beside them — is blocked repo-wide by the root `.gitignore` and
refused by `scripts/scrub-check.py`. A transcript of what people said in a
room is not something to push by accident.

## Mockups never enter the repo

Write the HTML outside the working tree and serve it with `attach_mockup`.
`.gitignore` holds `demos/*` and re-includes `demos/dev-server/` and
`demos/mockup/`, so a new page dropped at the top level of `demos/` stays out
of git. The few already tracked there predate the pattern and stay visible.

## Workflow: building-a-mock

Steps this project adds to the plugin's `building-a-mock` skill:

- **Start from a staging capture.** For a change to an existing surface, run
  `bun run staging` from a linked worktree, save the surface's served markup
  and its stylesheets from `http://127.0.0.1:8788`, and make the change in
  that copy. The mock loads the board's own stylesheets by their served
  paths (`/app/…`), which the mock frame inlines.
- **Render against prod's local address**, `http://127.0.0.1:8787`, with the
  path `attach_mockup` returned. The public hostname answers a sign-in.
