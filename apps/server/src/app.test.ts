import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "vite-plus/test";
import { createApp } from "./app.ts";
import { AppDatabase } from "./db.ts";
import { identify } from "./identity.ts";
import { CHIEF_NAME } from "./team.ts";
import type { AgentSummary } from "./workspace.ts";
import { Workspace } from "./workspace.ts";

const opened: Workspace[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((workspace) => workspace.close()));
});

async function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const db = new AppDatabase(":memory:");
  const workspaces = new Map<string, Promise<Workspace>>();
  const get = (userId: string) => {
    let workspace = workspaces.get(userId);
    if (workspace === undefined) {
      workspace = Workspace.open({
        userId,
        storage: new MemoryStorage(),
        models,
        defaultModel: { provider: model.provider, modelId: model.id },
        skillsDir: mkdtempSync(join(tmpdir(), "pibot-skills-")),
        selectable: [{ provider: model.provider, modelId: model.id }],
      }).then((open) => {
        opened.push(open);
        return open;
      });
      workspaces.set(userId, workspace);
    }
    return workspace;
  };
  const app = createApp({ db, workspaces: { get } });

  /** Signs a person in and returns a fetch that carries their session cookie. */
  const signIn = (subject: string) => {
    const user = db.upsertUser({ subject, email: `${subject}@example.com` });
    const cookie = `pibot_session=${db.createSession(user.id)}`;
    return (path: string, init: { method?: string; body?: string } = {}) =>
      app.request(`/api${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      });
  };
  return { faux, app, db, signIn, get };
}

test("everything but sign-in needs a session", async () => {
  const { app, db, signIn } = await setup();
  expect((await app.request("/api/health")).status).toBe(200);
  expect((await app.request("/api/agents")).status).toBe(401);
  expect(
    (await app.request("/api/agents", { headers: { cookie: "pibot_session=forged" } })).status,
  ).toBe(401);

  const ada = signIn("ada");
  expect(await (await ada("/me")).json()).toEqual({ email: "ada@example.com", name: null });

  // Signing out ends that session only.
  const logout = await ada("/auth/logout", { method: "POST" });
  expect(logout.headers.get("set-cookie")).toContain("pibot_session=;");
  expect(db.users()).toHaveLength(1);
});

test("each person has their own team, and cannot reach another person's agents", async () => {
  const { faux, signIn, get, db } = await setup();
  const ada = signIn("ada");
  const bob = signIn("bob");

  const created = await ada("/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Writer", description: "Drafts copy." }),
  });
  expect(created.status).toBe(201);
  const writer = (await created.json()) as AgentSummary;

  const adaAgents = (await (await ada("/agents")).json()) as AgentSummary[];
  const bobAgents = (await (await bob("/agents")).json()) as AgentSummary[];
  expect(adaAgents.map((agent) => agent.name)).toEqual([CHIEF_NAME, "Writer"]);
  expect(bobAgents.map((agent) => agent.name)).toEqual([CHIEF_NAME]);

  // Bob's workspace has no agent with the ID of Ada's writer.
  const message = { method: "POST", body: JSON.stringify({ content: "Hi" }) };
  expect((await bob(`/agents/${writer.id}/messages`, message)).status).toBe(404);

  faux.setResponses([fauxAssistantMessage("Hello Ada.")]);
  expect((await ada(`/agents/${writer.id}/messages`, message)).status).toBe(202);
  const adaId = db.users().find((user) => user.subject === "ada")!.id;
  const conversation = await (await get(adaId)).harness.conversation(writer.id, BACKGROUND_CONTEXT);
  await conversation!.waitForIdle(BACKGROUND_CONTEXT);
  const { messages } = await conversation!.context(BACKGROUND_CONTEXT);
  expect(messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Hello Ada." }] });
});

test("agents can be renamed, the Chief of Staff too, and removed, except the Chief of Staff", async () => {
  const { signIn } = await setup();
  const ada = signIn("ada");
  const [chief] = (await (await ada("/agents")).json()) as AgentSummary[];
  const writer = (await (
    await ada("/agents", { method: "POST", body: JSON.stringify({ name: "Writer" }) })
  ).json()) as AgentSummary;

  const renamed = await ada(`/agents/${writer.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Copywriter", instructions: "Write short." }),
  });
  expect(await renamed.json()).toMatchObject({ name: "Copywriter", revision: 2 });
  const rename = (name: string) => ({ method: "PATCH", body: JSON.stringify({ name }) });
  expect(await (await ada(`/agents/${chief!.id}`, rename("Boss"))).json()).toMatchObject({
    name: "Boss",
    role: "chief",
  });
  expect((await ada(`/agents/${chief!.id}`, rename("copywriter"))).status).toBe(400);
  expect((await ada(`/agents/${chief!.id}`, rename(CHIEF_NAME))).status).toBe(200);

  expect((await ada(`/agents/${chief!.id}`, { method: "DELETE" })).status).toBe(400);
  expect((await ada(`/agents/${writer.id}`, { method: "DELETE" })).status).toBe(200);
  const agents = (await (await ada("/agents")).json()) as AgentSummary[];
  expect(agents.map((agent) => agent.name)).toEqual([CHIEF_NAME]);
});

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

test("a person is identified by their ChatGPT user ID", async () => {
  const credential = (claims: object) => ({
    type: "oauth" as const,
    access: jwt(claims),
    refresh: "r",
    expires: 0,
  });
  expect(
    await identify(
      credential({
        sub: "auth0|1",
        "https://api.openai.com/auth": { chatgpt_user_id: "user-1" },
        "https://api.openai.com/profile": { email: "ada@example.com" },
      }),
    ),
  ).toEqual({ subject: "user-1", email: "ada@example.com" });
  expect(await identify(credential({ sub: "auth0|2" }))).toEqual({ subject: "auth0|2" });

  // An opaque token is identified through OpenAI's /v1/me.
  const fetchMe = (async () =>
    Response.json({ id: "user-3", email: "bob@example.com", name: "Bob" })) as typeof fetch;
  expect(
    await identify({ type: "oauth", access: "opaque", refresh: "r", expires: 0 }, fetchMe),
  ).toEqual({ subject: "user-3", email: "bob@example.com", name: "Bob" });
});

test("skills are uploaded for the person or one agent, and leave with the agent", async () => {
  const { signIn } = await setup();
  const ada = signIn("ada");
  const bob = signIn("bob");
  const skill = (name: string, extra: Record<string, string> = {}) =>
    JSON.stringify({
      files: { [`${name}/SKILL.md`]: `---\ndescription: ${name} things\n---\n\nDo it.`, ...extra },
    });

  const shared = await ada("/skills", { method: "POST", body: skill("writing") });
  expect(shared.status).toBe(201);
  expect(await shared.json()).toEqual({
    name: "writing",
    description: "writing things",
    scope: "person",
    files: [],
  });
  expect((await ada("/skills", { method: "POST", body: "{}" })).status).toBe(400);

  const writer = (await (
    await ada("/agents", { method: "POST", body: JSON.stringify({ name: "Writer" }) })
  ).json()) as AgentSummary;
  const own = await ada(`/agents/${writer.id}/skills`, {
    method: "POST",
    body: skill("drafting", { "drafting/tone/warm.md": "Be warm." }),
  });
  expect(await own.json()).toMatchObject({ name: "drafting", files: ["tone/warm.md"] });
  expect(await (await ada(`/agents/${writer.id}/skills/drafting`)).json()).toMatchObject({
    content: { "tone/warm.md": "Be warm." },
  });

  // Nobody else sees them.
  expect(await (await bob("/skills")).json()).toEqual([]);
  expect((await bob(`/agents/${writer.id}/skills`)).status).toBe(404);

  expect((await ada(`/agents/${writer.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await ada(`/agents/${writer.id}/skills`)).status).toBe(404);
  expect((await ada("/skills/writing", { method: "DELETE" })).status).toBe(200);
  expect(await (await ada("/skills")).json()).toEqual([]);
});

test("routines are managed per person over HTTP and run on demand", async () => {
  const { faux, signIn } = await setup();
  const ada = signIn("ada");
  const bob = signIn("bob");
  const [chief] = (await (await ada("/agents")).json()) as AgentSummary[];

  const bad = await ada("/routines", {
    method: "POST",
    body: JSON.stringify({
      agentId: chief!.id,
      name: "Too often",
      prompt: "Hi",
      schedule: "* * * * *",
      timeZone: "UTC",
    }),
  });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: expect.stringContaining("more often") });

  const created = await ada("/routines", {
    method: "POST",
    body: JSON.stringify({
      agentId: chief!.id,
      name: "Morning briefing",
      prompt: "Summarize the night.",
      schedule: "0 9 * * 1-5",
      timeZone: "Europe/Lisbon",
    }),
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; nextRunAt: string; createdBy: string };
  expect(routine).toMatchObject({ createdBy: "person", nextRunAt: expect.any(String) });

  // Another person sees none of it and cannot change it.
  expect(await (await bob("/routines")).json()).toEqual([]);
  expect(
    (await bob(`/routines/${routine.id}`, { method: "PATCH", body: '{"enabled":false}' })).status,
  ).toBe(400);

  const paused = await ada(`/routines/${routine.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  expect(await paused.json()).toMatchObject({ enabled: false });

  faux.setResponses([fauxAssistantMessage("Quiet night.")]);
  const run = await ada(`/routines/${routine.id}/run`, { method: "POST" });
  expect(run.status).toBe(202);
  expect(await run.json()).toMatchObject({ trigger: "manual" });

  expect((await ada(`/routines/${routine.id}`, { method: "DELETE" })).status).toBe(200);
  expect(await (await ada("/routines")).json()).toEqual([]);
});
