import type { Credential } from "@earendil-works/pi-ai";
import type { User } from "./db.ts";

/** OpenAI's namespaced JWT claims. */
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

type Claims = {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  [AUTH_CLAIM]?: { chatgpt_user_id?: unknown; user_id?: unknown };
  [PROFILE_CLAIM]?: { email?: unknown };
};

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The payload of a JWT, without verifying it: the token came straight from OpenAI's token endpoint. */
function jwtClaims(token: string): Claims | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
  } catch {
    return undefined;
  }
}

/**
 * Who signed in, from the ChatGPT access token. pi-ai keeps only the access and refresh tokens, so the identity comes
 * from the access token's claims, or from OpenAI's `/v1/me` when the token is not a readable JWT.
 */
export async function identify(
  credential: Credential,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<User, "id">> {
  if (credential.type !== "oauth") throw new Error("Expected a ChatGPT sign-in");
  const claims = jwtClaims(credential.access);
  const subject =
    nonEmpty(claims?.[AUTH_CLAIM]?.chatgpt_user_id) ??
    nonEmpty(claims?.[AUTH_CLAIM]?.user_id) ??
    nonEmpty(claims?.sub);
  if (claims !== undefined && subject !== undefined) {
    const email = nonEmpty(claims[PROFILE_CLAIM]?.email) ?? nonEmpty(claims.email);
    const name = nonEmpty(claims.name);
    return { subject, ...(email ? { email } : {}), ...(name ? { name } : {}) };
  }

  const response = await fetchImpl("https://api.openai.com/v1/me", {
    headers: { authorization: `Bearer ${credential.access}` },
  });
  if (!response.ok) throw new Error(`Could not identify the ChatGPT account (${response.status})`);
  const me = (await response.json()) as { id?: unknown; email?: unknown; name?: unknown };
  const id = nonEmpty(me.id);
  if (id === undefined) throw new Error("Could not identify the ChatGPT account");
  const email = nonEmpty(me.email);
  const name = nonEmpty(me.name);
  return { subject: id, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}
