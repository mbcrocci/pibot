import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, MemoryStorage } from "@earendil-works/pi-durable";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createApp } from "./app.ts";
import { type ConnectorView, INBOUND_MESSAGE, OAuthCallbacks, presets } from "./connectors.ts";
import { AppDatabase } from "./db.ts";
import { Vault } from "./vault.ts";
import { Workspace } from "./workspace.ts";

const servers: Server[] = [];
const opened: Workspace[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((workspace) => workspace.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stateless MCP server without auth: one read-only tool and one that writes. */
const fakeAds = () =>
  listen(async (request, response) => {
    const server = new McpServer({ name: "fake-ads", version: "1.0.0" });
    server.registerTool(
      "get_campaigns",
      {
        description: "List campaigns",
        inputSchema: { account: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ account }) => ({ content: [{ type: "text", text: `${account}: Spring launch` }] }),
    );
    server.registerTool(
      "pause_campaign",
      { description: "Pause a campaign", inputSchema: { id: z.string() } },
      async ({ id }) => ({ content: [{ type: "text", text: `paused ${id}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });

async function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const db = new AppDatabase(":memory:");
  const user = db.upsertUser({ subject: "ada" });
  const workspace = await Workspace.open({
    userId: user.id,
    storage: new MemoryStorage(),
    models,
    defaultModel: { provider: model.provider, modelId: model.id },
    skillsDir: await mkdtemp(join(tmpdir(), "pibot-skills-")),
    selectable: [{ provider: model.provider, modelId: model.id }],
    connectors: {
      db,
      vault: new Vault(randomBytes(32)),
      callbacks: new OAuthCallbacks("http://pibot.test"),
      publicUrl: "http://pibot.test",
      presets: presets({}),
    },
  });
  opened.push(workspace);
  const connectors = workspace.connectors!;
  const harness = workspace.harness;
  const [chief] = await workspace.team.agents(harness, BACKGROUND_CONTEXT);
  const specialist = await harness.commit(
    (tx) => workspace.team.createAgent(tx, { name: "Campaign Manager", description: "Ads." }),
    BACKGROUND_CONTEXT,
  );

  const conversation = async (id: ConversationId) =>
    (await harness.conversation(id, BACKGROUND_CONTEXT))!;
  const toolNames = async (id: ConversationId) =>
    (await (await conversation(id)).agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
  const send = async (id: ConversationId, content: string) => {
    await (
      await (await conversation(id)).submit({ type: "input", content }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
  };
  const results = async (id: ConversationId) => {
    const { messages } = await (await conversation(id)).context(BACKGROUND_CONTEXT);
    return messages
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map((message) => ({
        isError: message.isError,
        text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      }));
  };
  const grant = (connector: ConnectorView, access: "read" | "write" | null) =>
    connectors.update(connector.id, { grants: { [specialist.id]: access } });
  return {
    faux,
    db,
    user,
    workspace,
    connectors,
    chief: chief!,
    specialist,
    toolNames,
    send,
    results,
    grant,
    conversation,
  };
}

test("an MCP server's tools reach only the agents granted it, writes only with write access", async () => {
  const url = await fakeAds();
  const { faux, connectors, chief, specialist, toolNames, send, results, grant, conversation } =
    await setup();
  const ads = await connectors.create({
    kind: "mcp",
    name: "Fake Ads",
    config: { url: `${url}/mcp`, auth: "none", instructions: "Ask before spending." },
  });
  expect(await connectors.connect(ads.id)).toMatchObject({
    slug: "fake_ads",
    status: { state: "connected", tools: { read: 1, write: 1 } },
  });
  expect(await toolNames(specialist.id)).not.toContain("fake_ads__get_campaigns");

  await grant(ads, "read");
  expect(await toolNames(specialist.id)).toContain("fake_ads__get_campaigns");
  expect(await toolNames(specialist.id)).not.toContain("fake_ads__pause_campaign");
  expect(await toolNames(chief.id)).not.toContain("fake_ads__get_campaigns");

  await grant(ads, "write");
  expect(await toolNames(specialist.id)).toEqual(
    expect.arrayContaining(["fake_ads__get_campaigns", "fake_ads__pause_campaign"]),
  );
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("fake_ads__get_campaigns", { account: "acme" }),
        fauxToolCall("fake_ads__pause_campaign", { id: "42" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await send(specialist.id, "Check and pause");
  expect(await results(specialist.id)).toEqual([
    { isError: false, text: "acme: Spring launch" },
    { isError: false, text: "paused 42" },
  ]);
  const { messages } = await (await conversation(specialist.id)).context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(messages.find((message) => message.role === "system"))).toContain(
    "Ask before spending.",
  );

  // A grant is checked again at the call, so access taken away mid-run stops the agent.
  faux.setResponses([
    async () => {
      await grant(ads, "read");
      return fauxAssistantMessage(fauxToolCall("fake_ads__pause_campaign", { id: "7" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Could not."),
  ]);
  await send(specialist.id, "Pause 7");
  expect((await results(specialist.id)).at(-1)).toEqual({
    isError: true,
    // Whichever comes first refuses it: the agent no longer selects the write tools, or the grant check in the tool.
    text: expect.stringMatching(/not available|read-only access to Fake Ads/),
  });

  await grant(ads, null);
  expect(await toolNames(specialist.id)).not.toContain("fake_ads__get_campaigns");
});

test("an HTTP API gets its headers added, stays under its base URL, and reads only with read access", async () => {
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const url = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        auth: request.headers.authorization,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  const { faux, db, user, connectors, specialist, toolNames, send, results, grant } = await setup();
  const crm = await connectors.create({
    kind: "api",
    name: "CRM",
    config: { baseUrl: `${url}/v1` },
    headers: { Authorization: "Bearer s3cret" },
  });
  expect(crm.headers).toEqual(["Authorization"]);
  expect(JSON.stringify(crm)).not.toContain("s3cret");
  // Encrypted at rest.
  expect(JSON.stringify(db.connectors(user.id))).not.toContain("s3cret");

  await grant(crm, "read");
  expect(await toolNames(specialist.id)).toContain("crm__get");
  expect(await toolNames(specialist.id)).not.toContain("crm__request");

  await grant(crm, "write");
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("crm__get", { path: "/contacts", query: { q: "ada" } }),
        fauxToolCall("crm__get", { path: "../admin" }),
        fauxToolCall("crm__request", { method: "POST", path: "contacts", body: { name: "Ada" } }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await send(specialist.id, "Look up Ada");
  const [get, escape, post] = await results(specialist.id);
  expect(get).toEqual({ isError: false, text: 'GET /v1/contacts?q=ada → 200 OK\n\n{"ok":true}' });
  expect(escape).toMatchObject({ isError: true, text: expect.stringContaining("must stay under") });
  expect(post).toMatchObject({ isError: false });
  expect(seen).toEqual([
    { method: "GET", url: "/v1/contacts?q=ada", auth: "Bearer s3cret", body: "" },
    { method: "POST", url: "/v1/contacts", auth: "Bearer s3cret", body: '{"name":"Ada"}' },
  ]);
});

test("an inbound connector delivers posted messages to its agent as outside messages", async () => {
  const { db, workspace, connectors, chief, specialist, conversation } = await setup();
  await expect(connectors.create({ kind: "inbound", name: "Leads", config: {} })).rejects.toThrow(
    "Choose the agent",
  );
  const leads = await connectors.create({
    kind: "inbound",
    name: "Leads form",
    config: { agentId: specialist.id },
  });
  expect(leads.inboundUrl).toMatch(/^http:\/\/pibot\.test\/api\/inbound\/[\w-]{20,}$/);

  const app = createApp({ db, workspaces: { get: async () => workspace } });
  const post = (path: string, body: string, type = "application/json") =>
    app.request(path, {
      method: "POST",
      body,
      headers: { "content-type": type, "idempotency-key": "lead-1" },
    });
  const path = new URL(leads.inboundUrl!).pathname;
  expect((await post("/api/inbound/wrong", "{}")).status).toBe(404);
  expect((await post(path, JSON.stringify({ text: "New lead: Ada, wants a demo" }))).status).toBe(
    202,
  );
  // A retry with the same key is delivered once.
  expect((await post(path, JSON.stringify({ text: "New lead: Ada, wants a demo" }))).status).toBe(
    202,
  );

  const target = await conversation(specialist.id);
  await target.waitForIdle(BACKGROUND_CONTEXT);
  const { entries } = await target.context(BACKGROUND_CONTEXT);
  const inbound = entries.filter((entry) => entry.kind === INBOUND_MESSAGE);
  expect(inbound).toHaveLength(1);
  expect(inbound[0]).toMatchObject({
    data: { connectorName: "Leads form", text: "New lead: Ada, wants a demo" },
    model: [
      { role: "user", content: expect.stringContaining("an outside source (not the person)") },
    ],
  });

  // The Chief of Staff knows the connectors exist, and that only the person grants them.
  const chiefConversation = await conversation(chief.id);
  const agent = await chiefConversation.agent(BACKGROUND_CONTEXT);
  expect(agent.sections.map((item) => item.key)).toContain("connectors");
});

test("the Meta Ads preset needs a Meta app before it can connect", async () => {
  const { connectors } = await setup();
  const meta = await connectors.create({ preset: "meta_ads" });
  expect(meta).toMatchObject({
    name: "Meta Ads",
    slug: "meta_ads",
    preset: "meta_ads",
    config: { url: "https://mcp.facebook.com/ads", auth: "oauth" },
    status: { state: "unconfigured", error: expect.stringContaining("META_APP_ID") },
  });
  await expect(connectors.update(meta.id, { config: { url: "https://x.test" } })).rejects.toThrow(
    "fixed",
  );
});
