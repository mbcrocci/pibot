import { mkdtemp } from "node:fs/promises";
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
import { type ConversationId, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, test } from "vite-plus/test";
import { type Routine, type RoutineRun, Routines } from "./routines.ts";
import { ROUTINE_MESSAGE, Roster } from "./team.ts";
import { Workspace } from "./workspace.ts";

let workspace: Workspace | undefined;
afterEach(async () => {
  await workspace?.close();
  workspace = undefined;
});

const at = (iso: string) => Date.parse(iso);

async function setup(options: { storage?: Storage; now?: number } = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const clock = { now: options.now ?? at("2026-10-21T08:00:00Z") };
  const storage = options.storage ?? (await openNodeSqliteStorage(":memory:"));
  workspace = await Workspace.open({
    userId: "person",
    storage,
    models,
    defaultModel: { provider: model.provider, modelId: model.id },
    skillsDir: await mkdtemp(join(tmpdir(), "pibot-skills-")),
    selectable: [{ provider: model.provider, modelId: model.id }],
    now: () => clock.now,
  });
  const open = workspace;
  const roster = async () => (await open.harness.snapshot(Roster, BACKGROUND_CONTEXT))!.agents;
  const routines = async () =>
    (await open.harness.snapshot(Routines, BACKGROUND_CONTEXT))?.routines ?? [];
  const create = (agentId: ConversationId, fields: Partial<Routine> = {}) =>
    open.harness.commit(
      (tx) =>
        open.routines.create(
          tx,
          {
            agentId,
            name: "Morning briefing",
            prompt: "Summarize what happened overnight.",
            schedule: "0 9 * * *",
            timeZone: "Europe/Lisbon",
            ...fields,
          },
          { by: "person" },
        ),
      BACKGROUND_CONTEXT,
    );
  /** Waits until every run of every routine has settled. */
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const all = await routines();
      if (all.every((item) => item.runs.every((run) => !["firing", "queued"].includes(run.status))))
        return all;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Routine runs did not settle");
  };
  const entries = async (id: ConversationId) => {
    const conversation = (await open.harness.conversation(id, BACKGROUND_CONTEXT))!;
    return (await conversation.context(BACKGROUND_CONTEXT)).entries;
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
  const send = async (id: ConversationId, content: string) => {
    const conversation = (await open.harness.conversation(id, BACKGROUND_CONTEXT))!;
    await (
      await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
  };
  return { faux, open, clock, roster, routines, create, settled, entries, results, send };
}

test("a routine fires at its slot in its time zone and records the answer", async () => {
  // 09:00 in Lisbon is 08:00Z in October, before daylight saving time ends.
  const { faux, open, clock, roster, create, settled, entries } = await setup({
    now: at("2026-10-21T07:30:00Z"),
  });
  const [chief] = await roster();
  const routine = await create(chief!.id);
  expect(open.routines.summary(routine).nextRunAt).toBe("2026-10-21T08:00:00.000Z");

  await open.routines.tick();
  expect((await settled())[0]!.runs).toEqual([]);

  faux.setResponses([fauxAssistantMessage("Nothing happened overnight.")]);
  clock.now = at("2026-10-21T08:00:30Z");
  await open.routines.tick();
  const [fired] = await settled();
  expect(fired!.runs).toEqual([
    expect.objectContaining({
      trigger: "schedule",
      scheduledFor: "2026-10-21T08:00:00.000Z",
      status: "done",
      answer: expect.any(Number),
    }),
  ]);

  const message = (await entries(chief!.id)).find((entry) => entry.kind === ROUTINE_MESSAGE);
  expect(message).toMatchObject({
    data: { routineName: "Morning briefing", text: "Summarize what happened overnight." },
  });
  const content = JSON.stringify(message!.model);
  expect(content).toContain('Routine \\"Morning briefing\\"');
  expect(content).toContain("09:00 (Europe/Lisbon)");
  expect(content).toContain("The person set it up");

  // After daylight saving time ends, 09:00 in Lisbon is 09:00Z.
  clock.now = at("2026-10-26T00:00:00Z");
  expect(open.routines.summary({ ...fired!, since: "2026-10-26T00:00:00.000Z" }).nextRunAt).toBe(
    "2026-10-26T09:00:00.000Z",
  );
});

test("a schedule is checked: five fields, a real time zone, and runs at least five minutes apart", async () => {
  const { roster, create } = await setup();
  const [chief] = await roster();
  await expect(create(chief!.id, { schedule: "0 9 * *" })).rejects.toThrow("five cron fields");
  await expect(create(chief!.id, { schedule: "* * * * *" })).rejects.toThrow(
    "more often than every 5 minutes",
  );
  await expect(create(chief!.id, { schedule: "61 9 * * *" })).rejects.toThrow(
    "not a valid schedule",
  );
  await expect(create(chief!.id, { timeZone: "Mars/Olympus" })).rejects.toThrow("not a time zone");
  await create(chief!.id, { schedule: "*/5 * * * *" });
  await expect(create(chief!.id, { name: "morning BRIEFING" })).rejects.toThrow(
    "already a routine called Morning briefing",
  );
});

test("slots missed while the server was down fire once, and a busy routine skips its slot", async () => {
  const { faux, open, clock, roster, create, settled } = await setup({
    now: at("2026-10-21T08:00:00Z"),
  });
  const [chief] = await roster();
  await create(chief!.id, { schedule: "0 * * * *", timeZone: "UTC" });

  faux.setResponses([fauxAssistantMessage("Caught up.")]);
  clock.now = at("2026-10-21T11:30:00Z");
  await open.routines.tick();
  expect((await settled())[0]!.runs).toEqual([
    expect.objectContaining({
      scheduledFor: "2026-10-21T11:00:00.000Z",
      missed: 2,
      status: "done",
    }),
  ]);
  await open.routines.tick();
  expect((await settled())[0]!.runs).toHaveLength(1);

  // The next run is still unanswered when the slot after it comes.
  let answer!: () => void;
  const blocked = new Promise<void>((resolve) => (answer = resolve));
  faux.setResponses([
    async () => {
      await blocked;
      return fauxAssistantMessage("Late.");
    },
  ]);
  clock.now = at("2026-10-21T12:00:00Z");
  await open.routines.tick();
  clock.now = at("2026-10-21T13:00:00Z");
  await open.routines.tick();
  answer();
  const runs = (await settled())[0]!.runs;
  expect(runs.map((run) => [run.scheduledFor, run.status])).toEqual([
    ["2026-10-21T11:00:00.000Z", "done"],
    ["2026-10-21T12:00:00.000Z", "done"],
    ["2026-10-21T13:00:00.000Z", "skipped"],
  ]);
});

test("a paused or rescheduled routine does not fire the slots that passed meanwhile", async () => {
  const { open, clock, roster, create, settled } = await setup({
    now: at("2026-10-21T08:00:00Z"),
  });
  const [chief] = await roster();
  const routine = await create(chief!.id, { schedule: "0 * * * *", timeZone: "UTC" });
  await open.harness.commit(
    (tx) => open.routines.update(tx, routine.id, { enabled: false }, { by: "person" }),
    BACKGROUND_CONTEXT,
  );
  clock.now = at("2026-10-21T10:30:00Z");
  await open.routines.tick();
  expect(open.routines.summary((await settled())[0]!).nextRunAt).toBeUndefined();

  const resumed = await open.harness.commit(
    (tx) => open.routines.update(tx, routine.id, { enabled: true }, { by: "person" }),
    BACKGROUND_CONTEXT,
  );
  await open.routines.tick();
  expect((await settled())[0]!.runs).toEqual([]);
  expect(open.routines.summary(resumed).nextRunAt).toBe("2026-10-21T11:00:00.000Z");
});

test("a run interrupted by a crash reaches the agent exactly once after a restart", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "pibot-")), "pi-durable.sqlite");
  const first = await setup({ storage: await openNodeSqliteStorage(path) });
  const [chief] = await first.roster();
  const routine = await first.create(chief!.id, { schedule: "0 9 * * *", timeZone: "UTC" });

  // Two crashes: one after recording the run but before submitting it, and one after submitting it but before
  // recording that it was submitted.
  const firing = (scheduledFor: string): RoutineRun => ({
    trigger: "schedule",
    scheduledFor,
    firedAt: scheduledFor,
    status: "firing",
  });
  const beforeSubmit = firing("2026-10-21T09:00:00.000Z");
  const afterSubmit = firing("2026-10-22T09:00:00.000Z");
  await first.open.harness.commit(async (tx) => {
    const doc = await tx.doc(Routines);
    doc.routines[0]!.runs.push(beforeSubmit, afterSubmit);
  }, BACKGROUND_CONTEXT);
  const conversation = (await first.open.harness.conversation(chief!.id, BACKGROUND_CONTEXT))!;
  first.faux.setResponses([fauxAssistantMessage("Answered before the crash.")]);
  await (
    await conversation.submit(
      {
        type: "input",
        content: "Routine",
        entry: { kind: ROUTINE_MESSAGE, data: { scheduledFor: afterSubmit.scheduledFor } },
        requestId: `routine:${routine.id}:schedule:${afterSubmit.scheduledFor}`,
      },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  await first.open.close();
  workspace = undefined;

  const second = await setup({
    storage: await openNodeSqliteStorage(path),
    now: at("2026-10-22T10:00:00Z"),
  });
  second.faux.setResponses([fauxAssistantMessage("Morning.")]);
  const runs = (await second.settled())[0]!.runs;
  expect(runs.map((run) => [run.scheduledFor, run.status])).toEqual([
    ["2026-10-21T09:00:00.000Z", "done"],
    ["2026-10-22T09:00:00.000Z", "done"],
  ]);
  const messages = (await second.entries(chief!.id)).filter(
    (entry) => entry.kind === ROUTINE_MESSAGE,
  );
  expect(messages.map((entry) => (entry.data as { scheduledFor: string }).scheduledFor)).toEqual([
    "2026-10-22T09:00:00.000Z",
    "2026-10-21T09:00:00.000Z",
  ]);
});

test("the Chief of Staff sets up routines for teammates; a specialist only for itself", async () => {
  const { faux, open, roster, routines, send, results } = await setup({
    now: at("2026-10-21T07:00:00Z"),
  });
  const [chief] = await roster();
  const writer = await open.harness.commit(
    (tx) => open.team.createAgent(tx, { name: "Writer", description: "Drafts copy." }),
    BACKGROUND_CONTEXT,
  );

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("create_routine", {
        name: "Weekly newsletter",
        prompt: "Draft this week's newsletter.",
        schedule: "0 10 * * 1",
        timeZone: "UTC",
        agent: "Writer",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Set up."),
    fauxAssistantMessage(
      [
        fauxToolCall("create_routine", {
          name: "Chief check-in",
          prompt: "Check in.",
          schedule: "0 10 * * *",
          timeZone: "UTC",
          agent: "Chief of Staff",
        }),
        fauxToolCall("update_routine", { routine: "Weekly newsletter", enabled: false }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("list_routines", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  await send(chief!.id, "Have the writer draft a newsletter every Monday");
  await send(writer.id, "Pause the newsletter");

  expect(await results(chief!.id)).toEqual([
    {
      isError: false,
      text: "Set up Weekly newsletter for Writer. It first runs Mon 26 Oct, 10:00 (UTC).",
    },
  ]);
  const [setUp, paused, listed] = await results(writer.id);
  expect(setUp).toEqual({ isError: true, text: "You can set up routines only for yourself." });
  expect(paused).toEqual({ isError: false, text: "Updated Weekly newsletter. It is paused." });
  expect(listed!.text).toContain("- Weekly newsletter: `0 10 * * 1` in UTC, paused; never run");

  expect(await routines()).toEqual([
    expect.objectContaining({
      agentId: writer.id,
      createdBy: chief!.id,
      promptBy: chief!.id,
      enabled: false,
    }),
  ]);

  const conversation = (await open.harness.conversation(writer.id, BACKGROUND_CONTEXT))!;
  const { messages } = await conversation.context(BACKGROUND_CONTEXT);
  const system = JSON.stringify(messages.find((message) => message.role === "system"));
  expect(system).toContain("You can set up routines only for yourself.");
  expect(system).toContain("Weekly newsletter");

  // A routine an agent wrote is framed as not coming from the person.
  await open.harness.commit(
    async (tx) =>
      open.routines.update(
        tx,
        (await tx.doc(Routines)).routines[0]!.id,
        { enabled: true },
        { by: "person" },
      ),
    BACKGROUND_CONTEXT,
  );
  faux.setResponses([fauxAssistantMessage("Drafted.")]);
  const run = await open.routines.runNow((await routines())[0]!.id);
  expect(run.trigger).toBe("manual");
  const conversationEntries = (await conversation.context(BACKGROUND_CONTEXT)).entries;
  const fired = conversationEntries.find((entry) => entry.kind === ROUTINE_MESSAGE);
  expect(JSON.stringify(fired!.model)).toContain(
    "Chief of Staff wrote this prompt, not the person",
  );
});

test("removing an agent removes its routines", async () => {
  const { open, routines, create } = await setup();
  const writer = await open.harness.commit(
    (tx) => open.team.createAgent(tx, { name: "Writer", description: "Drafts copy." }),
    BACKGROUND_CONTEXT,
  );
  await create(writer.id);
  await open.routines.forgetAgent(writer.id);
  expect(await routines()).toEqual([]);
});
