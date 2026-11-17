import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Config = {
  readonly port: number;
  /** Directory holding app.sqlite and one pi-durable database per person. */
  readonly dataDir: string;
  /** The model new agents start with. */
  readonly model: ModelRef;
  /** Mark the session cookie `Secure`; set when PUBLIC_URL is https. */
  readonly secureCookies: boolean;
  /** This server as the browser reaches it, for OAuth callbacks and inbound connector URLs. */
  readonly publicUrl: string;
  /** App ID of the Meta app the Meta Ads connector signs in through. */
  readonly metaAppId?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    ...(env.META_APP_ID?.trim() ? { metaAppId: env.META_APP_ID.trim() } : {}),
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    model: { provider: "openai", modelId: env.MODEL_ID ?? "gpt-6.1-sol" },
    secureCookies: env.PUBLIC_URL?.startsWith("https://") ?? false,
  };
}
