import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { parseSkill, SkillStore, skillsExtension, unzip } from "./skills.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pibot-skills-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const agentId = 7 as ConversationId;
const skillMd = (name: string, description: string, body = "") =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}`;

/** A zip archive of `files`, deflated, as macOS's Compress makes them, with a directory and resource forks. */
export function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path);
    const raw = Buffer.from(content);
    const data = path.endsWith("/") ? raw : deflateRawSync(raw);
    const method = path.endsWith("/") ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("an uploaded folder keeps its files and loses its top directory and macOS metadata", () => {
  const skill = parseSkill({
    "analysis/SKILL.md": "---\ndescription: Analyse.\n---\n\nSee objectives/leads.md.",
    "analysis/objectives/leads.md": "# Leads",
    "analysis/.DS_Store": "junk",
    "__MACOSX/analysis/._SKILL.md": "junk",
  });
  expect(skill).toEqual({
    name: "analysis",
    description: "Analyse.",
    files: {
      "SKILL.md": "---\ndescription: Analyse.\n---\n\nSee objectives/leads.md.",
      "objectives/leads.md": "# Leads",
    },
  });

  expect(() => parseSkill({ "notes.md": "x" })).toThrow("needs a SKILL.md");
  expect(() => parseSkill({ "SKILL.md": "---\nname: x\n---\n" })).toThrow("description");
  expect(() => parseSkill({ "SKILL.md": skillMd("Bad Name", "x") })).toThrow("not a valid");
  expect(() => parseSkill({ "SKILL.md": skillMd("ok", "x"), "../escape.md": "x" })).toThrow(
    "outside the skill",
  );
  expect(() => parseSkill({ "SKILL.md": skillMd("ok", "x"), "logo.png": "\0PNG" })).toThrow(
    "not a text file",
  );
});

test("a zip archive unpacks into a skill folder", () => {
  const files = unzip(
    zip({
      "budget/": "",
      "__MACOSX/._budget": "\0junk",
      "budget/SKILL.md": skillMd("budget-setting", "Raise budgets.", "Add 20%."),
      "budget/steps/one.md": "Step one",
    }),
  );
  expect(files).toEqual({
    "budget/SKILL.md": skillMd("budget-setting", "Raise budgets.", "Add 20%."),
    "budget/steps/one.md": "Step one",
  });
  expect(parseSkill(files).name).toBe("budget-setting");
  expect(() => unzip(Buffer.from("not a zip"))).toThrow("not a zip file");
});

test("the store keeps the person's skills and each agent's own, the agent's winning", async () => {
  const store = new SkillStore(root);
  await store.install({ kind: "person" }, { "SKILL.md": skillMd("writing", "Write well.") });
  await store.install({ kind: "person" }, { "SKILL.md": skillMd("budget", "Person budget.") });
  await store.install(
    { kind: "agent", agentId },
    { "SKILL.md": skillMd("budget", "Agent budget."), "tables/rates.md": "| a |" },
  );

  expect(await store.available(agentId)).toEqual([
    { name: "budget", description: "Agent budget.", scope: "agent", files: ["tables/rates.md"] },
    { name: "writing", description: "Write well.", scope: "person", files: [] },
  ]);
  expect((await store.available(8 as ConversationId)).map((skill) => skill.description)).toEqual([
    "Person budget.",
    "Write well.",
  ]);

  // Installing again replaces the whole folder, and nothing is left aside.
  await store.install({ kind: "agent", agentId }, { "SKILL.md": skillMd("budget", "New.") });
  expect(await store.list({ kind: "agent", agentId })).toEqual([
    { name: "budget", description: "New.", scope: "agent", files: [] },
  ]);
  expect(await readdir(store.dir({ kind: "agent", agentId }))).toEqual(["budget"]);

  expect(await store.remove({ kind: "person" }, "writing")).toBe(true);
  expect(await store.remove({ kind: "person" }, "writing")).toBe(false);
  await store.removeAgent(agentId);
  expect(await store.list({ kind: "agent", agentId })).toEqual([]);
});

test("read_skill reads a skill and the files in its folder", async () => {
  const store = new SkillStore(root);
  await store.install(
    { kind: "agent", agentId },
    {
      "SKILL.md": skillMd("analysis", "Analyse.", "Read objectives/leads.md."),
      "objectives/leads.md": "# Leads checklist",
    },
  );
  const extension = skillsExtension(store);
  const prompt = await extension.sections![0]!.render(
    { conversationId: agentId } as never,
    BACKGROUND_CONTEXT,
  );
  expect(prompt).toContain("- analysis: Analyse.");
  expect(
    await extension.sections![0]!.render({ conversationId: 8 } as never, BACKGROUND_CONTEXT),
  ).toBeUndefined();

  const read = extension.tools![0]!;
  const call = (args: { name: string; file?: string }) =>
    read.execute(args, { conversationId: agentId } as ToolExecutionApi, BACKGROUND_CONTEXT);
  expect(await call({ name: "analysis" })).toMatchObject({
    isError: false,
    output: [{ text: expect.stringContaining("Files in this skill: objectives/leads.md") }],
  });
  expect(await call({ name: "analysis", file: "./objectives/leads.md" })).toMatchObject({
    isError: false,
    output: [{ text: "# Leads checklist" }],
  });
  expect(await call({ name: "analysis", file: "missing.md" })).toMatchObject({
    isError: true,
    output: [{ text: expect.stringContaining("objectives/leads.md") }],
  });
  expect(await call({ name: "other" })).toMatchObject({ isError: true });
});
