import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, TaskGraph } from "@earendil-works/pi-durable";
import { Hono, type Context as HonoContext } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { SignIn } from "./auth.ts";
import { ConnectorError, type Connectors, type OAuthCallbacks } from "./connectors.ts";
import type { AppDatabase, User } from "./db.ts";
import { catalog, choiceFor, validateChoice } from "./models.ts";
import { type RoutineChanges, RoutineError } from "./routines.ts";
import { MAX_SKILL_BYTES, type SkillFiles, type SkillScope, SkillError, unzip } from "./skills.ts";
import { Roster, TeamError } from "./team.ts";
import type { Workspace } from "./workspace.ts";

const SESSION_COOKIE = "pibot_session";
const LOGIN_COOKIE = "pibot_login";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const parseId = (raw: string): ConversationId | undefined => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? (id as ConversationId) : undefined;
};

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** The page an OAuth sign-in lands on in the person's browser; it closes itself on success. */
const callbackPage = (title: string, message: string, ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">
<div style="max-width:28rem;text-align:center"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div>
${ok ? "<script>setTimeout(() => window.close(), 1500)</script>" : ""}`;

const MAX_INBOUND_BYTES = 64 * 1024;

type Env = { Variables: { user: User; workspace: Workspace } };

/**
 * The HTTP API. Everything but health and sign-in needs a session, and every agent route reads only the signed-in
 * person's workspace, so an agent ID from another person's workspace is simply not found.
 */
export function createApp(options: {
  db: AppDatabase;
  workspaces: { get(userId: string): Promise<Workspace> };
  signIn?: SignIn;
  /** Where MCP sign-ins finish; absent in tests without OAuth. */
  callbacks?: OAuthCallbacks;
  secureCookies?: boolean;
}) {
  const { db, workspaces, signIn, callbacks, secureCookies = false } = options;
  const cookie = { httpOnly: true, sameSite: "Lax", path: "/", secure: secureCookies } as const;
  const app = new Hono<Env>().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true }));

  if (signIn !== undefined) {
    const loginId = (c: HonoContext) => getCookie(c, LOGIN_COOKIE);

    // Starts Sign in with ChatGPT and returns the URL to open; poll GET /auth/login for the outcome.
    app.post("/auth/login", async (c) => {
      const previous = loginId(c);
      if (previous !== undefined) signIn.cancel(previous);
      try {
        const { id, url } = await signIn.start();
        setCookie(c, LOGIN_COOKIE, id, { ...cookie, maxAge: 15 * 60 });
        return c.json({ url });
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 500);
      }
    });

    app.get("/auth/login", (c) => {
      const id = loginId(c);
      const state = id === undefined ? ({ status: "idle" } as const) : signIn.status(id);
      if (state.status === "signed_in") {
        setCookie(c, SESSION_COOKIE, state.token, { ...cookie, maxAge: SESSION_MAX_AGE });
        deleteCookie(c, LOGIN_COOKIE, { path: "/" });
        return c.json({ status: "signed_in" });
      }
      if (state.status !== "pending") deleteCookie(c, LOGIN_COOKIE, { path: "/" });
      return c.json(state);
    });

    // Fallback when the browser cannot reach the loopback callback: the pasted redirect URL.
    app.post("/auth/login/redirect", async (c) => {
      const id = loginId(c);
      const body = await c.req.json<{ url?: unknown }>().catch(() => ({}) as { url?: unknown });
      if (id === undefined) return c.json({ error: "No sign-in in progress" }, 409);
      if (typeof body.url !== "string") return c.json({ error: "Expected `url`" }, 400);
      try {
        signIn.submitRedirect(id, body.url);
        return c.json({ status: "pending" });
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 409);
      }
    });

    app.post("/auth/login/cancel", (c) => {
      const id = loginId(c);
      if (id !== undefined) signIn.cancel(id);
      deleteCookie(c, LOGIN_COOKIE, { path: "/" });
      return c.json({ status: "idle" });
    });
  }

  // Ends this browser's session. The person's agents keep working on whatever they were doing.
  app.post("/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) db.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // An MCP connector's OAuth redirect, opened in the person's browser; the state names the connector.
  app.get("/connectors/oauth/callback", async (c) => {
    const error = c.req.query("error_description") ?? c.req.query("error");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (error !== undefined || code === undefined || state === undefined) {
      return c.html(callbackPage("Not connected", error ?? "No code returned", false), 400);
    }
    if (callbacks === undefined) return c.html(callbackPage("Not connected", "", false), 404);
    try {
      const connector = await callbacks.finish(code, state);
      return connector.status.state === "connected"
        ? c.html(callbackPage(`${connector.name} connected`, "You can close this tab.", true))
        : c.html(
            callbackPage(
              `${connector.name} was not connected`,
              connector.status.error ?? connector.status.state,
              false,
            ),
            502,
          );
    } catch (cause) {
      return c.html(callbackPage("Not connected", errorMessage(cause), false), 400);
    }
  });

  // An inbound connector's URL: the token in the path is the only credential, so keep the URL secret. Takes
  // `{ text }`, `{ message }`, or a plain-text body; an `Idempotency-Key` header makes retries deliver once.
  app.post(
    "/inbound/:token",
    bodyLimit({
      maxSize: MAX_INBOUND_BYTES,
      onError: (c) => c.json({ error: "The message is too large." }, 413),
    }),
    async (c) => {
      const owner = db.inboundConnector(hashToken(c.req.param("token")));
      if (owner === undefined) return c.json({ error: "Not found" }, 404);
      const raw = await c.req.text();
      let message = raw;
      if ((c.req.header("content-type") ?? "").startsWith("application/json")) {
        try {
          const body = JSON.parse(raw) as unknown;
          const fields = (typeof body === "object" && body !== null ? body : {}) as Record<
            string,
            unknown
          >;
          message =
            optionalString(fields.text) ??
            optionalString(fields.message) ??
            JSON.stringify(body, null, 2);
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
      }
      const connectors = (await workspaces.get(owner.userId)).connectors;
      try {
        await connectors?.receive(owner.id, message, c.req.header("idempotency-key"));
      } catch (error) {
        if (error instanceof ConnectorError) return c.json({ error: error.message }, 400);
        throw error;
      }
      return c.json({ ok: true }, 202);
    },
  );

  // Everything below needs a signed-in person.
  app.use("*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? undefined : db.sessionUser(token);
    if (user === undefined) return c.json({ error: "Sign in to continue" }, 401);
    c.set("user", user);
    c.set("workspace", await workspaces.get(user.id));
    await next();
  });

  app.get("/me", (c) => {
    const { email, name } = c.var.user;
    return c.json({ email: email ?? null, name: name ?? null });
  });

  // The selectable models and the choice a new agent starts with.
  app.get("/models", async (c) => {
    const { models, defaultModel } = c.var.workspace;
    return c.json({ models: await catalog(models), default: choiceFor(models, defaultModel) });
  });

  app.get("/agents", async (c) => {
    const { harness } = c.var.workspace;
    const graph = await harness.taskGraph(BACKGROUND_CONTEXT);
    try {
      return c.json(await c.var.workspace.agents(graph.value, BACKGROUND_CONTEXT));
    } finally {
      graph.dispose();
    }
  });

  // Streams the agent list whenever a run starts or finishes, or the roster changes.
  app.get("/agents/watch", async (c) => {
    const workspace = c.var.workspace;
    const graph = await workspace.harness.taskGraph(BACKGROUND_CONTEXT);
    const roster = await workspace.harness.watchDoc(Roster, BACKGROUND_CONTEXT);
    return streamSSE(c, async (stream) => {
      let latest: TaskGraph = graph.value;
      let dirty = true;
      let refreshing = false;
      let sent: string | undefined;
      // One refresh at a time, always ending on the newest state.
      const refresh = () => {
        if (refreshing || !dirty) return;
        dirty = false;
        refreshing = true;
        void workspace
          .agents(latest, BACKGROUND_CONTEXT)
          .then(async (agents) => {
            const data = JSON.stringify(agents);
            if (data === sent || stream.aborted) return;
            sent = data;
            await stream.writeSSE({ event: "agents", data });
          })
          .catch((error: unknown) => console.error("[agents]", error))
          .finally(() => {
            refreshing = false;
            refresh();
          });
      };
      refresh();
      const unsubscribe = graph.subscribe((value) => {
        latest = value;
        dirty = true;
        refresh();
      });
      roster?.start(async () => {
        dirty = true;
        refresh();
      });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      unsubscribe();
      graph.dispose();
      await roster?.stop();
    });
  });

  // `{ name, description, instructions?, model?, thinkingLevel? }`: adds a specialist, as the Chief of Staff's
  // create_agent does.
  app.post("/agents", async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const name = optionalString(body.name);
    const description = optionalString(body.description) ?? "";
    const instructions = optionalString(body.instructions);
    if (name === undefined) return c.json({ error: "Expected `name`" }, 400);
    const { harness, team, models, defaultModel, selectable } = c.var.workspace;
    const choice =
      body.model !== undefined || body.thinkingLevel !== undefined
        ? validateChoice(models, body, defaultModel, selectable)
        : undefined;
    if (typeof choice === "string") return c.json({ error: choice }, 400);
    const context = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT);
    try {
      const agent = await harness.commit(
        (tx) =>
          team.createAgent(tx, {
            name,
            description,
            ...(instructions === undefined ? {} : { instructions }),
            ...(choice === undefined ? {} : { choice }),
          }),
        context,
      );
      return c.json(agent, 201);
    } catch (error) {
      if (error instanceof TeamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // `{ name?, description?, instructions?, model?, thinkingLevel?, reason? }`; omitted fields stay. Any agent can be
  // renamed, the Chief of Staff included.
  app.patch("/agents/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const context = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT);
    const workspace = c.var.workspace;
    if (id === undefined || (await workspace.agent(id, context)) === undefined) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const conversation = (await workspace.harness.conversation(id, context))!;

    const choiceRequested = body.model !== undefined || body.thinkingLevel !== undefined;
    const choice = choiceRequested
      ? validateChoice(
          workspace.models,
          body,
          (await conversation.agent(context)).model,
          workspace.selectable,
        )
      : undefined;
    if (typeof choice === "string") return c.json({ error: choice }, 400);

    const name = optionalString(body.name);
    const description = optionalString(body.description);
    const instructions = optionalString(body.instructions);
    const reason = optionalString(body.reason);
    try {
      const agent = await workspace.harness.commit(
        (tx) =>
          workspace.team.updateAgent(
            tx,
            id,
            {
              ...(name === undefined ? {} : { name }),
              ...(description === undefined ? {} : { description }),
              ...(instructions === undefined ? {} : { instructions }),
              ...(choice === undefined ? {} : { choice }),
            },
            { by: "person", ...(reason === undefined ? {} : { reason }) },
          ),
        context,
      );
      return c.json(agent);
    } catch (error) {
      if (error instanceof TeamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // Takes a specialist off the team and stops whatever it was doing.
  app.delete("/agents/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const context = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT);
    const workspace = c.var.workspace;
    if (id === undefined || (await workspace.agent(id, context)) === undefined) {
      return c.json({ error: "Agent not found" }, 404);
    }
    try {
      await workspace.harness.commit((tx) => workspace.team.removeAgent(tx, id), context);
    } catch (error) {
      if (error instanceof TeamError) return c.json({ error: error.message }, 400);
      throw error;
    }
    await (await workspace.harness.conversation(id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
    await workspace.skills.removeAgent(id);
    await workspace.routines.forgetAgent(id);
    await workspace.connectors?.forgetAgent(id);
    return c.json({ ok: true });
  });

  app.post("/agents/:id/messages", async (c) => {
    const id = parseId(c.req.param("id"));
    const body = await c.req
      .json<{ content?: unknown; requestId?: unknown }>()
      .catch(() => ({}) as { content?: unknown; requestId?: unknown });
    if (typeof body.content !== "string" || body.content.length === 0) {
      return c.json({ error: "Expected non-empty `content`" }, 400);
    }
    const context = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT);
    const workspace = c.var.workspace;
    if (id === undefined || (await workspace.agent(id, context)) === undefined) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const conversation = (await workspace.harness.conversation(id, context))!;
    // Admission is durable: the run continues even if this request or the process goes away.
    const submission = await conversation.submit(
      {
        type: "input",
        content: body.content,
        ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return c.json({ submissionId: submission.id }, 202);
  });

  // Stops the agent's current run.
  app.post("/agents/:id/abort", async (c) => {
    const id = parseId(c.req.param("id"));
    const workspace = c.var.workspace;
    if (id === undefined || (await workspace.agent(id, BACKGROUND_CONTEXT)) === undefined) {
      return c.json({ error: "Agent not found" }, 404);
    }
    await (await workspace.harness.conversation(id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
    return c.json({ ok: true });
  });

  // Streams the agent's conversation view (transcript, live generation, inbox, usage) on every commit.
  app.get("/agents/:id/view", async (c) => {
    const id = parseId(c.req.param("id"));
    const workspace = c.var.workspace;
    if (id === undefined || (await workspace.agent(id, BACKGROUND_CONTEXT)) === undefined) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const conversation = (await workspace.harness.conversation(id, BACKGROUND_CONTEXT))!;

    return streamSSE(c, async (stream) => {
      const view = await conversation.viewState(BACKGROUND_CONTEXT);
      // Delivers the current view first, then one value per commit that touches it.
      const unsubscribe = view.subscribe((value) =>
        stream.writeSSE({ event: "view", data: JSON.stringify(value) }),
      );
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      unsubscribe();
      view.dispose();
    });
  });

  // Skills: the person's under /skills, for every agent, and one agent's own under /agents/:id/skills.
  const skillScope = async (c: HonoContext<Env>): Promise<SkillScope | undefined> => {
    const raw = c.req.param("id");
    if (raw === undefined) return { kind: "person" };
    const id = parseId(raw);
    if (id === undefined || (await c.var.workspace.agent(id, BACKGROUND_CONTEXT)) === undefined) {
      return undefined;
    }
    return { kind: "agent", agentId: id };
  };

  /** An uploaded skill folder: a zip archive, or JSON `{ files: { [path]: text } }`. */
  const uploadedSkill = async (c: HonoContext<Env>): Promise<SkillFiles> => {
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("application/zip") || type.startsWith("application/octet-stream")) {
      return unzip(new Uint8Array(await c.req.arrayBuffer()));
    }
    const body = await c.req.json<{ files?: unknown }>().catch(() => ({}) as { files?: unknown });
    const files = body.files;
    if (
      typeof files !== "object" ||
      files === null ||
      Object.values(files).some((content) => typeof content !== "string")
    ) {
      throw new SkillError("Expected a zip file or `{ files: { [path]: text } }`.");
    }
    return files as SkillFiles;
  };

  for (const base of ["/skills", "/agents/:id/skills"]) {
    app.get(base, async (c) => {
      const scope = await skillScope(c);
      if (scope === undefined) return c.json({ error: "Agent not found" }, 404);
      return c.json(await c.var.workspace.skills.list(scope));
    });

    // Installs a skill folder, replacing the skill of the same name.
    app.post(
      base,
      bodyLimit({
        maxSize: MAX_SKILL_BYTES * 2,
        onError: (c) => c.json({ error: "That skill is too large." }, 413),
      }),
      async (c) => {
        const scope = await skillScope(c);
        if (scope === undefined) return c.json({ error: "Agent not found" }, 404);
        try {
          return c.json(await c.var.workspace.skills.install(scope, await uploadedSkill(c)), 201);
        } catch (error) {
          if (error instanceof SkillError) return c.json({ error: error.message }, 400);
          throw error;
        }
      },
    );

    // The skill with all its files.
    app.get(`${base}/:name`, async (c) => {
      const scope = await skillScope(c);
      if (scope === undefined) return c.json({ error: "Agent not found" }, 404);
      const skill = await c.var.workspace.skills.read(scope, c.req.param("name"));
      return skill === undefined ? c.json({ error: "Skill not found" }, 404) : c.json(skill);
    });

    app.delete(`${base}/:name`, async (c) => {
      const scope = await skillScope(c);
      if (scope === undefined) return c.json({ error: "Agent not found" }, 404);
      const removed = await c.var.workspace.skills.remove(scope, c.req.param("name"));
      return removed ? c.json({ ok: true }) : c.json({ error: "Skill not found" }, 404);
    });
  }

  // Routines: prompts agents receive on a schedule. Agents can set them up too, with the routines tools.
  const routineRoute =
    (handler: (workspace: Workspace, c: HonoContext<Env>) => Promise<Response>) =>
    async (c: HonoContext<Env>) => {
      try {
        return await handler(c.var.workspace, c);
      } catch (error) {
        if (error instanceof RoutineError) return c.json({ error: error.message }, 400);
        throw error;
      }
    };

  /** The fields of a routine in a request body that are present and of the right type. */
  const routineFields = (body: Record<string, unknown>): RoutineChanges => {
    const fields: RoutineChanges = {};
    for (const key of ["name", "prompt", "schedule", "timeZone"] as const) {
      const value = optionalString(body[key]);
      if (value !== undefined) fields[key] = value;
    }
    if (typeof body.enabled === "boolean") fields.enabled = body.enabled;
    return fields;
  };

  app.get(
    "/routines",
    routineRoute(async (workspace, c) =>
      c.json(await workspace.routines.list(workspace.harness, BACKGROUND_CONTEXT)),
    ),
  );

  // `{ agentId, name, prompt, schedule, timeZone, enabled? }`.
  app.post(
    "/routines",
    routineRoute(async (workspace, c) => {
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch((): Record<string, unknown> => ({}));
      const agentId = parseId(
        typeof body.agentId === "number"
          ? String(body.agentId)
          : (optionalString(body.agentId) ?? ""),
      );
      if (
        agentId === undefined ||
        (await workspace.agent(agentId, BACKGROUND_CONTEXT)) === undefined
      ) {
        return c.json({ error: "Agent not found" }, 404);
      }
      const { name, prompt, schedule, timeZone, enabled } = routineFields(body);
      if (
        name === undefined ||
        prompt === undefined ||
        schedule === undefined ||
        timeZone === undefined
      ) {
        return c.json({ error: "Expected `name`, `prompt`, `schedule`, and `timeZone`" }, 400);
      }
      const created = await workspace.harness.commit(
        (tx) =>
          workspace.routines.create(
            tx,
            {
              agentId,
              name,
              prompt,
              schedule,
              timeZone,
              ...(enabled === undefined ? {} : { enabled }),
            },
            { by: "person" },
          ),
        BACKGROUND_CONTEXT,
      );
      await workspace.routines.tick();
      return c.json(workspace.routines.summary(created), 201);
    }),
  );

  // `{ name?, prompt?, schedule?, timeZone?, enabled? }`; omitted fields stay.
  app.patch(
    "/routines/:id",
    routineRoute(async (workspace, c) => {
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch((): Record<string, unknown> => ({}));
      const updated = await workspace.harness.commit(
        (tx) =>
          workspace.routines.update(tx, c.req.param("id") ?? "", routineFields(body), {
            by: "person",
          }),
        BACKGROUND_CONTEXT,
      );
      await workspace.routines.tick();
      return c.json(workspace.routines.summary(updated));
    }),
  );

  app.delete(
    "/routines/:id",
    routineRoute(async (workspace, c) => {
      await workspace.harness.commit(
        (tx) => workspace.routines.remove(tx, c.req.param("id") ?? ""),
        BACKGROUND_CONTEXT,
      );
      await workspace.routines.tick();
      return c.json({ ok: true });
    }),
  );

  // Runs a routine now, whatever its schedule; its answer arrives in the agent's conversation.
  app.post(
    "/routines/:id/run",
    routineRoute(async (workspace, c) =>
      c.json(await workspace.routines.runNow(c.req.param("id") ?? ""), 202),
    ),
  );

  // Connectors: MCP servers, HTTP APIs, and inbound messages, which the person adds and grants to agents.
  const connectorsOf = (c: HonoContext<Env>): Connectors | undefined => c.var.workspace.connectors;
  const connectorRoute =
    (handler: (connectors: Connectors, c: HonoContext<Env>) => Promise<Response> | Response) =>
    async (c: HonoContext<Env>) => {
      const connectors = connectorsOf(c);
      if (connectors === undefined) return c.json({ error: "Connectors are not available" }, 404);
      try {
        return await handler(connectors, c);
      } catch (error) {
        if (error instanceof ConnectorError) return c.json({ error: error.message }, 400);
        throw error;
      }
    };
  const body = (c: HonoContext<Env>) =>
    c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));

  app.get(
    "/connectors",
    connectorRoute((connectors, c) =>
      c.json({ connectors: connectors.list(), presets: connectors.presets() }),
    ),
  );
  // `{ preset }`, or `{ kind, name, config, headers? }`.
  app.post(
    "/connectors",
    connectorRoute(async (connectors, c) => c.json(await connectors.create(await body(c)), 201)),
  );
  // `{ name?, config?, headers?, grants? }`; `grants` maps agent IDs to "read" or "write" and replaces all grants.
  app.patch(
    "/connectors/:id",
    connectorRoute(async (connectors, c) =>
      c.json(await connectors.update(c.req.param("id") ?? "", await body(c))),
    ),
  );
  app.delete(
    "/connectors/:id",
    connectorRoute(async (connectors, c) => {
      await connectors.remove(c.req.param("id") ?? "");
      return c.json({ ok: true });
    }),
  );
  // Connects an MCP server, or returns status `authorizing` with the `authorizationUrl` to open.
  app.post(
    "/connectors/:id/connect",
    connectorRoute(async (connectors, c) =>
      c.json(await connectors.connect(c.req.param("id") ?? "")),
    ),
  );
  // Disconnects an MCP server and forgets its sign-in.
  app.post(
    "/connectors/:id/disconnect",
    connectorRoute(async (connectors, c) =>
      c.json(await connectors.disconnect(c.req.param("id") ?? "")),
    ),
  );

  return app;
}
