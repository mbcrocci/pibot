import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

/**
 * Whose skill it is: the person's, which every one of their agents can use, or one agent's own. An agent's skill
 * wins over the person's skill of the same name.
 */
export type SkillScope = { kind: "person" } | { kind: "agent"; agentId: ConversationId };

/** A skill folder's files by `/`-separated path relative to the folder; `SKILL.md` is the entry point. */
export type SkillFiles = Record<string, string>;

/** What the skill list shows. */
export type SkillSummary = {
  name: string;
  description: string;
  scope: SkillScope["kind"];
  /** Every file but SKILL.md, sorted. */
  files: string[];
};

/** A skill with the contents of all its files, SKILL.md included. */
export type Skill = SkillSummary & { content: SkillFiles };

/** A user-facing reason a skill cannot be installed. */
export class SkillError extends Error {}

export const ENTRY = "SKILL.md";
/** Skill names follow the Agent Skills format: lowercase words joined by hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_LENGTH = 64;
export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The `key: value` lines of a leading `---` block; values may be quoted. */
export function frontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER.exec(content);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

/** A SKILL.md without its frontmatter. */
export const skillBody = (content: string) => content.replace(FRONTMATTER, "").trim();

/** A clean relative path, or undefined for one to leave out: hidden files and macOS archive metadata. */
function cleanPath(raw: string) {
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new SkillError(`${raw} points outside the skill.`);
  if (parts.length === 0 || parts[0] === "__MACOSX") return undefined;
  if (parts.some((part) => part.startsWith("."))) return undefined;
  return parts.join("/");
}

/**
 * Checks an uploaded skill folder and returns its name, description, and files. A folder uploaded with its own
 * top-level directory, as zips and folder pickers do, has that directory stripped; its name is the fallback for a
 * SKILL.md without `name`.
 */
export function parseSkill(upload: SkillFiles): {
  name: string;
  description: string;
  files: SkillFiles;
} {
  let files: SkillFiles = {};
  for (const [raw, content] of Object.entries(upload)) {
    const path = cleanPath(raw);
    if (path !== undefined) files[path] = content;
  }
  let folder: string | undefined;
  const paths = Object.keys(files);
  const top = paths[0]?.split("/")[0];
  if (
    files[ENTRY] === undefined &&
    top !== undefined &&
    paths.every((path) => path.startsWith(`${top}/`))
  ) {
    folder = top;
    files = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path.slice(top.length + 1), content]),
    );
  }

  const entry = files[ENTRY];
  if (entry === undefined) throw new SkillError(`A skill needs a ${ENTRY} at its top level.`);
  const fields = frontmatter(entry);
  const name = fields.name || folder || "";
  if (!NAME.test(name) || name.length > NAME_LENGTH) {
    throw new SkillError(
      name === ""
        ? `Give the skill a name in the frontmatter of ${ENTRY}.`
        : `"${name}" is not a valid skill name: use lowercase letters, digits, and hyphens, up to ${NAME_LENGTH}.`,
    );
  }
  if (!fields.description) {
    throw new SkillError(`Give the skill a description in the frontmatter of ${ENTRY}.`);
  }

  const count = Object.keys(files).length;
  if (count > MAX_FILES) throw new SkillError(`A skill can have up to ${MAX_FILES} files.`);
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content);
    if (content.includes("\0")) throw new SkillError(`${path} is not a text file.`);
    if (bytes > MAX_FILE_BYTES) {
      throw new SkillError(`${path} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    }
    total += bytes;
  }
  if (total > MAX_SKILL_BYTES) {
    throw new SkillError(`A skill can hold up to ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
  }
  return { name, description: fields.description, files };
}

/**
 * The text files of a zip archive, by path. Directories are left out; a file that is not UTF-8 text makes the
 * whole archive fail, so a skill never silently loses part of itself.
 */
export function unzip(archive: Uint8Array): SkillFiles {
  const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new SkillError("That is not a zip file.");
  const entries = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (entries > MAX_FILES * 4) throw new SkillError(`A skill can have up to ${MAX_FILES} files.`);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: SkillFiles = {};
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new SkillError("The zip file is damaged.");
    const method = data.readUInt16LE(at + 10);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const offset = data.readUInt32LE(at + 42);
    const path = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith("/") || cleanPath(path) === undefined) continue;
    if (size > MAX_FILE_BYTES) {
      throw new SkillError(`${path} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    }
    if (data.readUInt32LE(offset) !== 0x04034b50) throw new SkillError("The zip file is damaged.");
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    const stored = data.subarray(start, start + compressedSize);
    let bytes: Buffer;
    if (method === 0) bytes = stored;
    else if (method === 8) {
      try {
        bytes = inflateRawSync(stored, { maxOutputLength: MAX_FILE_BYTES });
      } catch {
        throw new SkillError(`${path} is damaged or larger than ${MAX_FILE_BYTES / 1024} KB.`);
      }
    } else throw new SkillError(`${path} uses a zip compression pibot cannot read.`);
    total += bytes.length;
    if (total > MAX_SKILL_BYTES) {
      throw new SkillError(`A skill can hold up to ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
    }
    try {
      files[path] = decoder.decode(bytes);
    } catch {
      throw new SkillError(`${path} is not a text file.`);
    }
  }
  return files;
}

/** Every file under `dir`, by `/`-separated path relative to it. */
async function readFolder(dir: string): Promise<SkillFiles> {
  const files: SkillFiles = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (cleanPath(path) !== undefined) files[path] = await readFile(join(dir, path), "utf8");
  }
  return files;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * One person's skills on disk, under their data directory:
 *
 * - `skills/<name>/`: the person's, for every agent.
 * - `agents/<id>/skills/<name>/`: one agent's own.
 *
 * Each skill is a folder with a `SKILL.md` and any other text files it links to. Skills are read from disk on use,
 * so a change applies from an agent's next answer.
 */
export class SkillStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(scope: SkillScope) {
    return scope.kind === "person"
      ? join(this.root, "skills")
      : join(this.root, "agents", String(scope.agentId), "skills");
  }

  /** The skills in one scope, sorted by name. Folders without a valid SKILL.md are skipped. */
  async list(scope: SkillScope): Promise<SkillSummary[]> {
    const dir = this.dir(scope);
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    const skills: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skill = await this.read(scope, entry.name);
      if (skill !== undefined) {
        const { content: _, ...summary } = skill;
        skills.push(summary);
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The skill called `name` in one scope, with all its files. */
  async read(scope: SkillScope, name: string): Promise<Skill | undefined> {
    if (!NAME.test(name)) return undefined;
    const content = await readFolder(join(this.dir(scope), name)).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    const entry = content?.[ENTRY];
    if (content === undefined || entry === undefined) return undefined;
    const fields = frontmatter(entry);
    if (!fields.description) return undefined;
    return {
      name,
      description: fields.description,
      scope: scope.kind,
      files: Object.keys(content)
        .filter((path) => path !== ENTRY)
        .sort(),
      content,
    };
  }

  /** The skills an agent can use: its own, then the person's it does not override. */
  async available(agentId: ConversationId): Promise<SkillSummary[]> {
    const [own, person] = await Promise.all([
      this.list({ kind: "agent", agentId }),
      this.list({ kind: "person" }),
    ]);
    const names = new Set(own.map((skill) => skill.name));
    return [...own, ...person.filter((skill) => !names.has(skill.name))];
  }

  /** Reads one of an agent's skills, its own before the person's. */
  async readFor(agentId: ConversationId, name: string) {
    return (
      (await this.read({ kind: "agent", agentId }, name)) ??
      (await this.read({ kind: "person" }, name))
    );
  }

  /**
   * Installs an uploaded skill folder in one scope, replacing a skill of the same name. The new folder is written
   * aside and swapped in, so an agent never reads half a skill.
   */
  async install(scope: SkillScope, upload: SkillFiles): Promise<SkillSummary> {
    const { name, files } = parseSkill(upload);
    const dir = this.dir(scope);
    const staging = join(dir, `.staging-${randomUUID()}`);
    const target = join(dir, name);
    const old = join(dir, `.old-${randomUUID()}`);
    try {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(staging, path)), { recursive: true });
        await writeFile(join(staging, path), content);
      }
      const replacing = await rename(target, old).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
      await rename(staging, target);
      if (replacing) await rm(old, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const { content: _, ...summary } = (await this.read(scope, name))!;
    return summary;
  }

  /** Removes a skill; false when there was none. */
  async remove(scope: SkillScope, name: string) {
    if (!NAME.test(name)) return false;
    const dir = join(this.dir(scope), name);
    const exists = await readdir(dir).then(
      () => true,
      () => false,
    );
    await rm(dir, { recursive: true, force: true });
    return exists;
  }

  /** Removes everything an agent kept, such as when it leaves the team. */
  async removeAgent(agentId: ConversationId) {
    await rm(join(this.root, "agents", String(agentId)), { recursive: true, force: true });
  }
}

const text = (value: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text: value }],
  isError,
});

/**
 * The `skills` extension: lists the skills an agent can use in its prompt, and `read_skill` loads one, or one of the
 * files in its folder, when a task matches.
 */
export function skillsExtension(store: SkillStore) {
  return defineExtension({
    name: "skills",
    sections: [
      section("skills", async (input) => {
        const skills = await store.available(input.conversationId);
        if (skills.length === 0) return undefined;
        const list = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
        return (
          "Skills hold instructions for specific tasks. When a task matches a skill's description, call " +
          "read_skill with its name and follow it before acting. When a skill points to one of its files, call " +
          `read_skill with the skill's name and that path as file.\n\n${list}`
        );
      }),
    ],
    tools: [
      defineTool({
        name: "read_skill",
        description:
          "Read a skill listed in the skills section, or, with file, one of the files in the skill's folder.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, description: "The skill's name" }),
          file: Type.Optional(
            Type.String({
              description: "A path inside the skill's folder, such as objectives/leads.md",
            }),
          ),
        }),
        replay: "safe",
        execute: async ({ name, file }, api) => {
          const skill = await store.readFor(api.conversationId, name);
          if (skill === undefined) return text(`There is no skill called ${name}.`, true);
          const listing =
            skill.files.length === 0 ? "" : `\n\nFiles in this skill: ${skill.files.join(", ")}`;
          if (file === undefined) return text(`${skill.content[ENTRY]!}${listing}`);
          const path = file.replace(/^\.?\//, "");
          const content = skill.content[path];
          return content === undefined
            ? text(
                `The ${name} skill has no file ${file}. ${skill.files.length === 0 ? "It has no other files." : `Its files: ${skill.files.join(", ")}.`}`,
                true,
              )
            : text(content);
        },
      }),
    ],
  });
}
