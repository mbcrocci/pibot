<img src="assets/icon.svg" width="64" height="64" alt="">

# pibot

A team of agents that work together for you, built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
Every person signs in with ChatGPT and gets a **Chief of Staff**: their main point of contact, which answers, delegates
to the other agents, and creates new specialists as the person needs them.

A [Vite+](https://viteplus.dev) monorepo:

| Package                      | What it is                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| [`apps/server`](apps/server) | Node + Hono backend: sign-in, the app database, and each person's pi-durable `Harness` (port 8787) |
| [`apps/web`](apps/web)       | TanStack Start client (port 3000); proxies `/api` to the server in development                     |

## Getting started

Requires Node.js 22.19+ (for `node:sqlite`) and the `vp` CLI.

```sh
vp install
vp run dev     # web + server; open http://localhost:3000 and continue with ChatGPT
```

Other commands:

```sh
vp run dev:server   # backend only
vp run dev:web      # web client only
vp check            # format, lint, type check
vp run -r test      # tests
vp run -r build     # production builds
```

## How it fits together

- **Sign-in** ([`auth.ts`](apps/server/src/auth.ts), [`identity.ts`](apps/server/src/identity.ts)): Sign in with
  ChatGPT is the only way in. The first sign-in creates the person, keyed by their ChatGPT user ID from the access
  token. Their token is stored for their agents, and the browser gets an httpOnly session cookie.
- **App database** ([`db.ts`](apps/server/src/db.ts)): `data/app.sqlite` holds people, sessions (hashed tokens), and
  each person's provider credentials.
- **Workspaces** ([`workspace.ts`](apps/server/src/workspace.ts)): each person has their own pi-durable database
  (`data/users/<id>/pi-durable.sqlite`), `Harness`, and model catalog on their own ChatGPT credential. Ambient
  credentials such as `OPENAI_API_KEY` are ignored, so nobody's agents run on someone else's account, and agents can only
  see their own teammates. Every workspace reopens at startup and resumes unfinished runs.
- **The team** ([`team.ts`](apps/server/src/team.ts)): each agent is one long-lived conversation, listed in the `pibot.roster`
  document. Every agent gets the `team` extension: who it is, who its teammates are, `list_agents`, and
  `message_agent` (optionally waiting for the answer). The Chief of Staff also gets `staff`: `create_agent` and
  `update_agent`, which can pick a model and thinking level, and `update_agent` must say why. A message reaches the
  other agent as a user message from that agent. Waiting on a busy agent fails instead of deadlocking, and a chain of
  agent messages stops after four hops, so agents cannot keep each other busy without the person.
- **Agent history:** every agent has a `revision` and its last 20 `changes`: what changed, who changed it (the person
  or an agent), when, and why. The person can rename any agent, the Chief of Staff included; it keeps its title, so
  teammates still find it as "Chief of Staff".
- **Skills** ([`skills.ts`](apps/server/src/skills.ts)): a skill is a folder with a `SKILL.md` (`name` and
  `description` in its frontmatter) and any text files it points to. The person's skills live in
  `data/users/<id>/skills/<name>/` and every agent can use them; an agent's own live in
  `data/users/<id>/agents/<agentId>/skills/<name>/` and win over a shared skill of the same name. Every agent gets the
  `skills` extension: the skills it can use are listed in its prompt, and `read_skill` loads one, or a file in its
  folder. Skills are uploaded as a folder or a zip, replace the skill of the same name, and are read from disk on use.
- **Connectors** ([`connectors.ts`](apps/server/src/connectors.ts)): outside services the person adds under
  Connectors: an **MCP server** (OAuth sign-in, a secret header, or no auth; the **Meta Ads** preset is Meta's hosted
  Ads MCP), an **HTTP API** under one base URL with secret headers (`<slug>__get`, `<slug>__request`), or **inbound
  messages**: a secret URL whose posts reach one agent, framed as coming from outside. Only the person grants agents
  `read` access (MCP tools marked read-only, GETs) or `write` access (everything); agents cannot grant themselves
  anything, the grant decides which tools an agent is offered, and every call checks it again. Secrets are encrypted
  with AES-256-GCM in `app.sqlite` under a key in `data/secrets.key`, and never reach a model.
- **Routines** ([`routines.ts`](apps/server/src/routines.ts)): a prompt one agent receives on a schedule, a five-field
  cron expression read in an IANA time zone (at most 50 per agent, at least 5 minutes apart), listed in the
  `pibot.routines` document with its last 20 runs. A run is recorded as `firing`, submitted to the agent with the
  request ID `routine:<id>:<trigger>:<slot>`, then recorded as `queued` and `done` or `unanswered`. A crash between
  steps leaves a run that the next start submits again under the same request ID, which finds the submission pi-durable
  already admitted, so each run reaches the agent once. Slots missed while the server was down fire once on start (with
  the count missed); a slot whose previous run has not finished is `skipped`; pausing or rescheduling skips slots that
  passed meanwhile. Every agent gets the `routines` extension (`list_routines`, `create_routine`, `update_routine`,
  `delete_routine`) for its own routines, and the Chief of Staff for anyone's. A prompt an agent wrote arrives framed as
  not coming from the person, like a teammate's message, and a routine run starts a new chain of agent messages.

## Backend API

| Method & path                         | Purpose                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/health`                     | Liveness check                                                                                |
| `POST /api/auth/login`                | Start Sign in with ChatGPT → `{ url }` to open                                                |
| `GET /api/auth/login`                 | Poll the sign-in; `signed_in` sets the session cookie                                         |
| `POST /api/auth/login/redirect`       | Finish sign-in with a pasted redirect `{ url }`                                               |
| `POST /api/auth/login/cancel`         | Cancel the pending sign-in                                                                    |
| `POST /api/auth/logout`               | End this browser's session; the person's agents keep working                                  |
| `GET /api/me`                         | The signed-in person's `email` and `name`                                                     |
| `GET /api/models`                     | Selectable models, their thinking levels, and the default                                     |
| `GET /api/agents`                     | The team, the Chief of Staff first, with `working` and `lastEntryId`                          |
| `GET /api/agents/watch`               | Server-sent events: the team whenever it or a run changes                                     |
| `POST /api/agents`                    | Add a specialist `{ name, description, instructions?, model?, thinkingLevel? }`               |
| `PATCH /api/agents/:id`               | Change `{ name, description, instructions, model, thinkingLevel }`, with an optional `reason` |
| `DELETE /api/agents/:id`              | Take a specialist off the team and stop its work                                              |
| `POST /api/agents/:id/messages`       | Durably submit `{ content, requestId? }` → `{ submissionId }`                                 |
| `POST /api/agents/:id/abort`          | Stop the agent's current run                                                                  |
| `GET /api/agents/:id/view`            | Server-sent events: the agent's conversation view on every commit                             |
| `GET /api/skills`                     | The person's skills, shared by every agent                                                    |
| `POST /api/skills`                    | Install a skill: a zip (`application/zip`) or `{ files: { [path]: text } }`                   |
| `GET /api/skills/:name`               | A skill with the contents of all its files                                                    |
| `DELETE /api/skills/:name`            | Remove a skill                                                                                |
| `… /api/agents/:id/skills…`           | The same four routes for one agent's own skills                                               |
| `GET /api/connectors`                 | The person's connectors (status, grants, header names) and presets                            |
| `POST /api/connectors`                | Add one: `{ preset }` or `{ kind, name, config, headers? }`                                   |
| `PATCH /api/connectors/:id`           | Change `{ name, config, headers, grants }`; `grants` maps agent IDs to `read` or `write`      |
| `DELETE /api/connectors/:id`          | Remove a connector, its tools, and its credentials                                            |
| `POST /api/connectors/:id/connect`    | Connect an MCP server, or get the `authorizationUrl` to sign in                               |
| `POST /api/connectors/:id/disconnect` | Disconnect an MCP server and forget its sign-in                                               |
| `GET /api/connectors/oauth/callback`  | Where MCP sign-ins finish (no session needed)                                                 |
| `POST /api/inbound/:token`            | Deliver a message to an inbound connector's agent (no session needed)                         |
| `GET /api/routines`                   | The person's routines with `nextRunAt` and their latest runs                                  |
| `POST /api/routines`                  | Add one: `{ agentId, name, prompt, schedule, timeZone, enabled? }`                            |
| `PATCH /api/routines/:id`             | Change `{ name, prompt, schedule, timeZone, enabled }`                                        |
| `DELETE /api/routines/:id`            | Remove a routine; a run already submitted still gets its answer                               |
| `POST /api/routines/:id/run`          | Run it now, whatever its schedule                                                             |

Everything after sign-in needs the session cookie and reads only the signed-in person's workspace.

## Limits for now

- pi-ai's ChatGPT sign-in listens on `127.0.0.1:1455` for the OAuth redirect, so one sign-in runs at a time and the
  browser must be on the server's machine; otherwise the person pastes the final redirect URL into the sign-in page.
- One server process owns the data directory; there is no cross-process locking. That includes routines: two processes
  on the same data would both fire them (the request ID still keeps each run to one submission).
- A routine's answer stays in its agent's conversation; nothing notifies the person yet.
- Agents reach outside services only through the connectors the person grants them. Write tools rely on the agent
  asking the person first; the server does not enforce approval prompts yet.
- The Meta Ads connector needs `META_APP_ID` (a Meta app with the ads MCP use case), with pibot's callback,
  `PUBLIC_URL/api/connectors/oauth/callback`, among the app's redirect URIs.
