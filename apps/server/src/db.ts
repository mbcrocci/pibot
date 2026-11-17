import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export type User = {
  id: string;
  /** The ChatGPT account's stable user ID. */
  subject: string;
  email?: string;
  name?: string;
};

/** How long a sign-in lasts. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record TEXT NOT NULL,
  secrets TEXT,
  inbound_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  credential TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);
`;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

type UserRow = { id: string; subject: string; email: string | null; name: string | null };

const toUser = (row: UserRow): User => ({
  id: row.id,
  subject: row.subject,
  ...(row.email ? { email: row.email } : {}),
  ...(row.name ? { name: row.name } : {}),
});

/** A stored connector: its JSON record, its secrets encrypted, and the hash of its inbound token, if any. */
export type ConnectorRow = { id: string; record: string; secrets: string | null };

/**
 * The app's own data: the people who signed in, their sessions, their provider tokens, and their connectors. Agents
 * and their conversations live in each person's pi-durable database, not here.
 */
export class AppDatabase {
  readonly #db: DatabaseSync;
  readonly #stores = new Map<string, UserCredentialStore>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  /** Creates the person on first sign-in; later sign-ins refresh their email and name. */
  upsertUser(identity: Omit<User, "id">): User {
    const row = this.#db
      .prepare(
        `INSERT INTO users (id, subject, email, name, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (subject) DO UPDATE SET email = excluded.email, name = excluded.name
         RETURNING id, subject, email, name`,
      )
      .get(
        randomUUID(),
        identity.subject,
        identity.email ?? null,
        identity.name ?? null,
        Date.now(),
      ) as UserRow;
    return toUser(row);
  }

  users(): User[] {
    return (this.#db.prepare("SELECT id, subject, email, name FROM users").all() as UserRow[]).map(
      toUser,
    );
  }

  /** Starts a session and returns its token, which only the cookie holds. */
  createSession(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.#db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hash(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  sessionUser(token: string): User | undefined {
    const row = this.#db
      .prepare(
        `SELECT users.id, users.subject, users.email, users.name FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(hash(token), Date.now()) as UserRow | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  deleteSession(token: string) {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  }

  /** The person's connectors, oldest first. */
  connectors(userId: string): ConnectorRow[] {
    return this.#db
      .prepare(
        "SELECT id, record, secrets FROM connectors WHERE user_id = ? ORDER BY created_at, id",
      )
      .all(userId) as ConnectorRow[];
  }

  saveConnector(
    userId: string,
    row: ConnectorRow & { inboundHash?: string | undefined; createdAt: number },
  ) {
    this.#db
      .prepare(
        `INSERT INTO connectors (id, user_id, record, secrets, inbound_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET record = excluded.record, secrets = excluded.secrets,
           inbound_hash = excluded.inbound_hash
         WHERE connectors.user_id = excluded.user_id`,
      )
      .run(row.id, userId, row.record, row.secrets, row.inboundHash ?? null, row.createdAt);
  }

  deleteConnector(userId: string, id: string) {
    this.#db.prepare("DELETE FROM connectors WHERE user_id = ? AND id = ?").run(userId, id);
  }

  /** Whose connector an inbound token belongs to, by the token's hash. */
  inboundConnector(tokenHash: string): { userId: string; id: string } | undefined {
    const row = this.#db
      .prepare("SELECT user_id, id FROM connectors WHERE inbound_hash = ?")
      .get(tokenHash) as { user_id: string; id: string } | undefined;
    return row === undefined ? undefined : { userId: row.user_id, id: row.id };
  }

  /** The person's provider tokens, which their agents' model requests use and refresh. */
  credentialStore(userId: string): CredentialStore {
    let store = this.#stores.get(userId);
    if (store === undefined) {
      // One store per person, so their writes share one serialized line.
      store = new UserCredentialStore(this.#db, userId);
      this.#stores.set(userId, store);
    }
    return store;
  }

  close() {
    this.#db.close();
  }
}

/** One person's credentials. Writes are serialized in-process, which is enough for a single server. */
class UserCredentialStore implements CredentialStore {
  readonly #db: DatabaseSync;
  readonly #userId: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(db: DatabaseSync, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async read(providerId: string) {
    return this.#read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.#db
      .prepare("SELECT provider_id, credential FROM credentials WHERE user_id = ?")
      .all(this.#userId) as { provider_id: string; credential: string }[];
    return rows.map((row) => ({
      providerId: row.provider_id,
      type: (JSON.parse(row.credential) as Credential).type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    return this.#serialize(async () => {
      const current = this.#read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      this.#db
        .prepare(
          `INSERT INTO credentials (user_id, provider_id, credential) VALUES (?, ?, ?)
           ON CONFLICT (user_id, provider_id) DO UPDATE SET credential = excluded.credential`,
        )
        .run(this.#userId, providerId, JSON.stringify(next));
      return next;
    });
  }

  delete(providerId: string) {
    return this.#serialize(async () => {
      this.#db
        .prepare("DELETE FROM credentials WHERE user_id = ? AND provider_id = ?")
        .run(this.#userId, providerId);
    });
  }

  #read(providerId: string): Credential | undefined {
    const row = this.#db
      .prepare("SELECT credential FROM credentials WHERE user_id = ? AND provider_id = ?")
      .get(this.#userId, providerId) as { credential: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.credential) as Credential);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(task);
    this.#chain = result.catch(() => {});
    return result;
  }
}
