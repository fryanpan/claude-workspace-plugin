# Voice conversation API

Any app that speaks the OpenAI chat format can hold a spoken conversation
with one agent on the owner's boards, and switch to another, without
knowing what a board is. The phone does speech-to-text and text-to-speech;
the server only ever sees text.

The first client is the voice page (`/voice?agent=<id>`), which talks over
its board's converse socket instead. The protocol below is for every other
client: a native app, an open-source one such as Conduit, or `curl`.

## The shape

| Step | Call |
| --- | --- |
| Auth | `Authorization: Bearer <voice token>` on every call |
| List agents | `GET /v1/models` |
| Start a conversation | `POST /v1/chat/completions` with one user message |
| Send a turn | the same call, with the messages so far plus the new user message |
| Receive the reply | the response: a stream of chunks, or one completion |
| Switch agent | the same call with a different `model` |

`GET /v1/models` answers the OpenAI list shape, one entry per agent. `id` is
the agent's id, the value to put in `model`. Two extra fields, `name` and
`description` (for example "On Harborlight, listening now"), are for clients
that show more than an id; plain OpenAI clients ignore them.

A turn is the OpenAI request body. The server reads `model`, `messages` and
`stream`, and ignores everything else (`temperature`, `tools` and so on).

- The last message must be a `user` message with text. That is the turn.
- Earlier `user` and `assistant` messages are passed to the agent as the
  conversation so far, newest 12 kept. `system` messages are dropped.
- Content may be a string or an array of `{type: "text", text}` parts.
  Other parts are ignored.
- A turn is at most 4,000 characters, and a request at most 512 KB.

The conversation id is the `x-conversation-id` header when the client sends
one (1 to 100 of `A-Za-z0-9_-`). Otherwise it is derived from the token, the
model and the first user message. So a client that keeps its messages array
keeps its conversation, and one that starts a new chat starts a new one. Two
chats on one token that open with the same words to the same agent share an
id; a client that cares sends the header.

### The reply

With `stream: true` (what voice clients send) the reply is server-sent
events in the OpenAI chunk format, ending `data: [DONE]`:

1. At once, the role chunk carrying `Working on it.`, so the phone is not
   silent while the agent works.
2. A `: keepalive` comment line every 15 seconds while it waits.
3. The agent's answer as one content chunk, then a `stop` chunk and
   `[DONE]`.

Without `stream`, the reply is one `chat.completion` holding the answer.

| Case | What the client hears |
| --- | --- |
| The agent answers in time | its answer |
| The agent holds no stream now | at once: "&lt;name&gt; is away. I'll pass it on when they're back." The turn waits on the agent's queue |
| No answer within the bound | "&lt;name&gt; is still working on it. Ask me again in a bit and I'll tell you what they said." |
| The answer lands after that | said first on the conversation's next turn: "&lt;name&gt; answered your earlier question: …" |
| `model` names no agent | HTTP 404, `model_not_found` |
| No valid, unrevoked token | HTTP 401, `invalid_api_key` |

Errors use the OpenAI error shape, `{error: {message, type, code}}`.

## Why chat completions, streamed, with these bounds

**Chat completions over the Responses API.** The Responses API fits a slow
answer better: `background: true`, then poll `GET /v1/responses/{id}`, with
`previous_response_id` for continuity. But the clients we want to work
unchanged call chat completions. Conduit, the iOS and Android client with an
Action Button intent and an Android assistant service, connects to any
OpenAI-compatible endpoint through `/v1/chat/completions`, and so do the
OpenAI SDKs' default paths. A Responses endpoint would need a client
written for it. The cost of chat completions is that the server must hold
the request open, which the bounds below handle.

**Streamed, with an interim line.** An agent answers through `answer_voice`
in seconds to minutes. Streaming lets the phone say something within a
second and keeps the connection busy, so no proxy closes it as idle.

**180 seconds for a stream, 90 for a whole answer.** Cloudflare closes a
response that has sent no byte for 100 seconds. A stream sends a keepalive
every 15 seconds, so it is not bound by that; 180 seconds is about how long
a person holds a phone waiting before they would rather be told to ask
again. A response that is not streamed sends nothing until the answer, so it
must close under 100 seconds; 90 leaves a margin. Either way, an answer that
comes later is not lost: it is said on the next turn.

## Auth

A voice token is `vk1.<id>.<mac>`, signed through
`packages/server/src/auth/signed-token.ts` under its own key domain
(`cw-voice-api-token-v1`), derived from the server's cookie key. No other
signed value verifies as one, and it verifies as nothing else.

- **Minted by the owner:** `POST /api/voice/tokens` with `{label}` answers
  the token once. The server keeps only the record (id, label, who it speaks
  for, when made, last used, when revoked) in `voice-api-tokens.json` under
  the data dir, mode 600.
- **Listed:** `GET /api/voice/tokens`, without values.
- **Revoked:** `POST /api/voice/tokens/<id>/revoke`. The record stays,
  marked, and the token stops working on its next call.
- **Grants only this API.** `/v1/models` and `/v1/chat/completions` read
  this token and nothing else: no cookie, no Access identity, no agent or
  widget token opens them. No other route reads a voice token.

The token routes are the owner's alone, gated as the voice page's agent
list is: a share or collaboration visitor and a signed-in person who is not
the owner are refused, and a browser's write must come from this server's
own origin. Through the tunnel they also need a proof that names the owner,
so a phone holding only an Access service token cannot mint itself more.

### Reaching it from a phone

The routes sit on the owner's hostname, behind Cloudflare Access like every
other route there. A phone reaches them in one of two ways:

- **An Access service token**, sent as two custom headers
  (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) alongside the bearer.
  Conduit supports custom headers. This needs a Service Auth policy on the
  owner's Access application. The server's Access check accepts a verified
  token that names no email (`middleware/cf-access.ts`); this has not been
  tried against a live service-token policy.
- **The tailnet**, where Access does not apply. Not done today: the server
  refuses its Tailscale name on every route but the widget's.

A client that runs in a browser on another site (a web chat UI's "direct
connection") is not supported. These routes add no CORS rule of their own, so
a browser is let through only from an origin the server already allows for
the widget (`middleware/browser-origin.ts`).

## Where it is written

| Part | File |
| --- | --- |
| Wire format, pure | `packages/server/src/voice-api/protocol.ts` |
| One turn: interim line, keepalive, bounds, late answers | `packages/server/src/voice-api/chat.ts` |
| The token | `packages/server/src/voice-api/tokens.ts` |
| Workspaces' side: what a model is, how a turn reaches it | `packages/server/src/voice-api/backend.ts` |
| Routes | `packages/server/src/routes/voice-api.ts` |

`protocol.ts` and `chat.ts` know nothing about boards. `chat.ts` asks a
`VoiceAgents` for the list and to send a turn; `backend.ts` is the only
implementation. It places an agent on the board where it holds a stream
now, else the board it leads, else the first, and sends the turn exactly as
the converse socket does: a row on that agent's own comment queue, then a
frame on its own streams, answered only by that agent's `answer_voice`.

## Who may use it, and what changes for more people

Today only the owner can mint a token, and every token speaks for the
owner. Each record already names who it speaks for (`subject`), so turns
are attributed to that person.

- **A per-person allowlist** goes in the token routes' gate
  (`refuseNonOwner` in `routes/voice-api.ts`): admit the listed people, mint
  with their identity as `subject`. `backend.ts`'s board list would then be
  that person's boards rather than the owner's.
- **A native sign-in** mints through the same `VoiceApiTokens.mint` call
  after its own proof of the person, and hands the app the token.
