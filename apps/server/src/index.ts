import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { CHATGPT_PROVIDER, SignIn } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { OAuthCallbacks, presets } from "./connectors.ts";
import { AppDatabase } from "./db.ts";
import { loadDeviceId } from "./device.ts";
import { identify } from "./identity.ts";
import { Vault } from "./vault.ts";
import { Workspaces } from "./workspace.ts";

const config = loadConfig();
const db = new AppDatabase(join(config.dataDir, "app.sqlite"));
const callbacks = new OAuthCallbacks(config.publicUrl);
const workspaces = new Workspaces({
  db,
  dataDir: config.dataDir,
  defaultModel: config.model,
  connectors: {
    vault: await Vault.open(join(config.dataDir, "secrets.key")),
    callbacks,
    publicUrl: config.publicUrl,
    presets: presets(config),
  },
});

const deviceId = await loadDeviceId(join(config.dataDir, "device-id"));
const signIn = new SignIn({
  deviceId,
  // Finds or creates the person, keeps their ChatGPT token for their agents, and opens their workspace.
  complete: async (credential) => {
    const user = db.upsertUser(await identify(credential));
    await db.credentialStore(user.id).modify(CHATGPT_PROVIDER, async () => credential);
    await workspaces.get(user.id);
    return db.createSession(user.id);
  },
});

// Continue any run the previous process left unfinished, in every person's workspace.
await workspaces.resumeAll();

const server = serve(
  {
    fetch: createApp({
      db,
      workspaces,
      signIn,
      callbacks,
      secureCookies: config.secureCookies,
    }).fetch,
    port: config.port,
  },
  (info) => {
    console.log(`pibot server listening on http://localhost:${info.port}`);
  },
);

const shutdown = async () => {
  signIn.close();
  server.close();
  await workspaces.close();
  db.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
