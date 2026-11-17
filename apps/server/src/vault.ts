import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = "v1";

/**
 * Encrypts secrets at rest with AES-256-GCM, so a copy of the app database alone does not reveal connector tokens.
 * The key lives in its own file, readable only by the owner.
 */
export class Vault {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("A vault key is 32 bytes");
    this.#key = key;
  }

  /** The vault whose key is at `path`, creating the key the first time. */
  static async open(path: string): Promise<Vault> {
    try {
      return new Vault(Buffer.from((await readFile(path, "utf8")).trim(), "base64"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key.toString("base64"), { mode: 0o600, flag: "wx" });
    return new Vault(key);
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [
      VERSION,
      ...[iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")),
    ].join(":");
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error("Unknown secret format");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  }
}
