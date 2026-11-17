import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, test } from "vite-plus/test";
import { AGENT_MESSAGE, CHIEF_NAME, MAX_MESSAGE_DEPTH, Roster } from "./team.ts";
import { Workspace } from "./workspace.ts";

let workspace: Workspace | undefined;
afterEach(() => workspace?.close());

async function setup(storage: Storage = new MemoryStorage()) {
  // A plain default model, and a second one that reasons, to choose for an agent.
  const faux = fauxProvider({
    models: [{ id: "faux-1" }, { id: "faux-thinker", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  workspace = await Workspace.open({
    userId: "person",
    storage,
    models,
    defaultModel: { provider: model.provider, modelId: model.id },
    skillsDir: await mkdtemp(join(tmpdir(), "pibot-skills-")),
    selectable: faux.models.map((item) => ({ provider: item.provider, modelId: item.id })),
  });
  const open = workspace;
  const roster = async () => (await open.harness.snapshot(Roster, BACKGROUND_CONTEXT))!.agents;

  const send = async (id: ConversationId, content: string) => {
    const conversation = (await open.harness.conversation(id, BACKGROUND_CONTEXT))!;
    await (
      await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
  };
  const results = async (id: ConversationId) => {
    const conversation = (await open.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const { messages } = await conversation.context(BACKGROUND_CONTEXT);
    return messages
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map((message) => ({
        isError: message.isError,
        text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      }));
  };
  const addSpecialist = (name: string, description: string) =>
    open.harness.commit(
      (tx) => open.team.createAgent(tx, { name, description }),
      BACKGROUND_CONTEXT,
    );
  return { faux, open, roster, send, results, addSpecialist };
}

test("a new workspace starts with only the Chief of Staff, once", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "pibot-")), "pi-durable.sqlite");
  const { open, roster } = await setup(await openNodeSqliteStorage(path));
  const [chief, ...others] = await roster();
  expect(others).toEqual([]);
  expect(chief).toMatchObject({ name: CHIEF_NAME, role: "chief" });

  const agent = await (await open.harness.conversation(chief!.id, BACKGROUND_CONTEXT))!.agent(
    BACKGROUND_CONTEXT,
  );
  expect(agent.extensions.map((extension) => extension.name)).toEqual([
    "team",
    "staff",
    "skills",
    "routines",
  ]);
  expect(agent.tools.map((tool) => tool.name)).toEqual([
    "list_agents",
    "message_agent",
    "create_agent",
    "update_agent",
    "read_skill",
    "list_routines",
    "create_routine",
    "update_routine",
    "delete_routine",
  ]);

  await open.close();
  const { roster: reopened } = await setup(await openNodeSqliteStorage(path));
  expect(await reopened()).toEqual([chief]);
});

test("the Chief of Staff creates a specialist and gets its answer back", async () => {
  const { faux, open, roster, send, results } = await setup();
  const [chief] = await roster();

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("create_agent", {
        name: "Researcher",
        description: "Finds and summarizes sources.",
        instructions: "You research topics and cite sources.",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("message_agent", {
        agent: "researcher",
        message: "Summarize the history of tea.",
        wait: true,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Tea began in China."),
    fauxAssistantMessage("The Researcher says tea began in China."),
  ]);
  await send(chief!.id, "Get me a researcher and ask it about tea");

  const researcher = (await roster())[1]!;
  expect(researcher).toMatchObject({
    name: "Researcher",
    description: "Finds and summarizes sources.",
    role: "specialist",
  });
  expect(await results(chief!.id)).toEqual([
    { isError: false, text: "Created Researcher. Message it with message_agent." },
    { isError: false, text: "Researcher answered:\n\nTea began in China." },
  ]);

  const conversation = (await open.harness.conversation(researcher.id, BACKGROUND_CONTEXT))!;
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  expect(agent.extensions.map((extension) => extension.name)).toEqual([
    "team",
    "skills",
    "routines",
  ]);
  const { messages, entries } = await conversation.context(BACKGROUND_CONTEXT);
  const system = messages.find((message) => message.role === "system");
  expect(JSON.stringify(system)).toContain("You are Researcher");
  expect(JSON.stringify(system)).toContain("You research topics and cite sources.");
  expect(entries.find((entry) => entry.kind === AGENT_MESSAGE)).toMatchObject({
    data: { from: chief!.id, fromName: CHIEF_NAME, depth: 1 },
    model: [
      { role: "user", content: `Message from ${CHIEF_NAME}:\n\nSummarize the history of tea.` },
    ],
  });
});

test("agent names are unique and only the Chief of Staff shapes the team", async () => {
  const { faux, open, roster, send, results, addSpecialist } = await setup();
  const writer = await addSpecialist("Writer", "Drafts copy.");
  await expect(addSpecialist("writer", "Another")).rejects.toThrow(
    "already an agent called Writer",
  );

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("list_agents", {}),
        fauxToolCall("create_agent", { name: "Spy", description: "x", instructions: "x" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await send(writer.id, "Look around");
  const [listed, created] = await results(writer.id);
  expect(listed!.text).toBe(
    `- ${CHIEF_NAME}: Your main point of contact. Coordinates the other agents.\n` +
      "- Writer (you, working): Drafts copy.",
  );
  // The specialist is not offered create_agent, so the call fails.
  expect(created!.isError).toBe(true);
  expect((await roster()).map((agent) => agent.name)).toEqual([CHIEF_NAME, "Writer"]);

  const [chief] = await roster();
  await expect(
    open.harness.commit((tx) => open.team.removeAgent(tx, chief!.id), BACKGROUND_CONTEXT),
  ).rejects.toThrow("cannot be removed");
  await open.harness.commit((tx) => open.team.removeAgent(tx, writer.id), BACKGROUND_CONTEXT);
  expect((await roster()).map((agent) => agent.name)).toEqual([CHIEF_NAME]);
});

test("waiting on a busy agent fails instead of deadlocking", async () => {
  const { faux, roster, send, results, addSpecialist } = await setup();
  const [chief] = await roster();
  const writer = await addSpecialist("Writer", "Drafts copy.");

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("message_agent", { agent: "Writer", message: "Ask me back", wait: true }),
      { stopReason: "toolUse" },
    ),
    // The writer asks back while the Chief of Staff waits for it.
    fauxAssistantMessage(
      fauxToolCall("message_agent", { agent: CHIEF_NAME, message: "What?", wait: true }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("You were busy."),
    fauxAssistantMessage("Done."),
  ]);
  await send(chief!.id, "Start");

  expect(await results(writer.id)).toEqual([
    { isError: true, text: expect.stringContaining(`${CHIEF_NAME} is busy`) },
  ]);
  expect(await results(chief!.id)).toEqual([
    { isError: false, text: "Writer answered:\n\nYou were busy." },
  ]);
});

test(`a chain of agent messages stops after ${MAX_MESSAGE_DEPTH} hops`, async () => {
  const { faux, open, roster, results, addSpecialist } = await setup();
  const [chief] = await roster();
  const writer = await addSpecialist("Writer", "Drafts copy.");

  // Every message makes its receiver message the other agent, without waiting, until the chain is cut.
  const relay: FauxResponseFactory = (context) => {
    if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Sent.");
    const other = JSON.stringify(context).includes("You are Writer") ? CHIEF_NAME : "Writer";
    return fauxAssistantMessage(fauxToolCall("message_agent", { agent: other, message: "Over" }), {
      stopReason: "toolUse",
    });
  };
  faux.setResponses(Array.from({ length: 20 }, () => relay));
  const conversation = (await open.harness.conversation(chief!.id, BACKGROUND_CONTEXT))!;
  await conversation.submit({ type: "input", content: "Start" }, BACKGROUND_CONTEXT);
  const other = (await open.harness.conversation(writer.id, BACKGROUND_CONTEXT))!;
  for (let round = 0; round < MAX_MESSAGE_DEPTH + 2; round++) {
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    await other.waitForIdle(BACKGROUND_CONTEXT);
  }

  // Depths 1 to 4 are delivered, alternating from the Chief of Staff; the fifth hop is refused.
  const sent = [...(await results(chief!.id)), ...(await results(writer.id))];
  expect(sent.filter((result) => !result.isError)).toHaveLength(MAX_MESSAGE_DEPTH);
  expect(sent.filter((result) => result.isError)).toEqual([
    {
      isError: true,
      text: expect.stringContaining(`already passed through ${MAX_MESSAGE_DEPTH} agents`),
    },
  ]);
});

test("the Chief of Staff picks a model and records why it changed an agent", async () => {
  const { faux, open, roster, send, results } = await setup();
  const [chief] = await roster();

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("create_agent", {
        name: "Analyst",
        description: "Crunches numbers.",
        instructions: "You analyse data.",
        model: "faux-thinker",
        thinkingLevel: "high",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("create_agent", {
          name: "Other",
          description: "x",
          instructions: "x",
          model: "no-such-model",
        }),
        fauxToolCall("update_agent", {
          agent: "Analyst",
          name: "Data Analyst",
          thinkingLevel: "low",
          reason: "The person wants quicker answers",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await send(chief!.id, "Set up an analyst");

  const [, unknown, updated] = await results(chief!.id);
  expect(unknown).toMatchObject({
    isError: true,
    text: expect.stringContaining("no model no-such-model"),
  });
  expect(updated).toMatchObject({
    isError: false,
    text: expect.stringContaining("Updated Data Analyst"),
  });

  const analyst = (await roster())[1]!;
  expect(analyst).toMatchObject({ name: "Data Analyst", revision: 2 });
  expect(analyst.changes).toEqual([
    expect.objectContaining({ revision: 1, by: chief!.id, fields: ["created"] }),
    expect.objectContaining({
      revision: 2,
      by: chief!.id,
      fields: ["name", "model"],
      reason: "The person wants quicker answers",
    }),
  ]);
  const agent = await (await open.harness.conversation(analyst.id, BACKGROUND_CONTEXT))!.agent(
    BACKGROUND_CONTEXT,
  );
  expect(agent).toMatchObject({ model: { modelId: "faux-thinker" }, thinkingLevel: "low" });
});

test("the person can rename the Chief of Staff, which keeps its title", async () => {
  const { faux, open, roster, send, results, addSpecialist } = await setup();
  const [chief] = await roster();
  const writer = await addSpecialist("Writer", "Drafts copy.");
  await open.harness.commit(
    (tx) => open.team.updateAgent(tx, chief!.id, { name: "Pip" }),
    BACKGROUND_CONTEXT,
  );
  expect((await roster())[0]).toMatchObject({
    name: "Pip",
    revision: 2,
    changes: [expect.anything(), expect.objectContaining({ by: "person", fields: ["name"] })],
  });

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("list_agents", {}),
        // The old title still finds the Chief of Staff.
        fauxToolCall("message_agent", { agent: CHIEF_NAME, message: "Hi" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
    fauxAssistantMessage("Hello."),
  ]);
  await send(writer.id, "Look around");
  const [listed, messaged] = await results(writer.id);
  expect(listed!.text).toContain(`- Pip (${CHIEF_NAME}): Your main point of contact.`);
  expect(messaged).toMatchObject({
    isError: false,
    text: "Sent to Pip. Its answer stays in its own conversation.",
  });
});
