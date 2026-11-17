import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A stable UUID for this installation, which Sign in with ChatGPT registers as the agent host. */
export async function loadDeviceId(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, id, { mode: 0o600 });
  return id;
}
