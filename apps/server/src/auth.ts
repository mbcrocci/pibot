import { randomBytes } from "node:crypto";
import {
  type AuthContext,
  type AuthInteraction,
  type Credential,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** The provider behind Sign in with ChatGPT: OpenAI's Responses API with a ChatGPT subscription token. */
export const CHATGPT_PROVIDER = "openai";

/** Ignore OPENAI_API_KEY and other ambient credentials: each person's agents run only on their own sign-in. */
export const NO_AMBIENT_AUTH: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/** An abandoned sign-in gives up the callback port after this long. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type LoginStatus =
  | { status: "idle" }
  | { status: "pending"; url?: string }
  | { status: "error"; error: string }
  /** Carries the new session's token, handed out once. */
  | { status: "signed_in"; token: string };

type Login = {
  abort: AbortController;
  state: LoginStatus;
  manual?: (url: string) => void;
  timer: NodeJS.Timeout;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sign in with ChatGPT, as the only way into pibot. Each login is keyed by a random ID that the starting browser keeps
 * in a cookie. pi-ai's flow listens on 127.0.0.1:1455 for the OAuth redirect, so only one login runs at a time and the
 * browser must run on the server's machine; otherwise the person pastes the redirect URL.
 */
export class SignIn {
  readonly #logins = new Map<string, Login>();
  readonly #deviceId: string;
  /** Turns a fresh ChatGPT credential into a session token: finds or creates the person and stores the credential. */
  readonly #complete: (credential: Credential) => Promise<string>;

  constructor(options: {
    deviceId: string;
    complete: (credential: Credential) => Promise<string>;
  }) {
    this.#deviceId = options.deviceId;
    this.#complete = options.complete;
  }

  /** Starts a login. Resolves with its ID and the URL to open in the browser. */
  async start(): Promise<{ id: string; url: string }> {
    const id = randomBytes(24).toString("base64url");
    const login = this.#run(id);
    return new Promise((resolve, reject) => {
      const check = () => {
        const state = login.state;
        if (state.status === "pending" && state.url) return resolve({ id, url: state.url });
        if (state.status === "error") return reject(new Error(state.error));
        if (state.status !== "pending") return reject(new Error("Sign-in ended"));
        setTimeout(check, 50);
      };
      check();
    });
  }

  /** The login's state. A finished login is forgotten once its session token has been handed out. */
  status(id: string): LoginStatus {
    const login = this.#logins.get(id);
    if (login === undefined) return { status: "idle" };
    if (login.state.status === "signed_in" || login.state.status === "error") this.#forget(id);
    return login.state;
  }

  /** Completes a pending login with the redirect URL copied from the browser. */
  submitRedirect(id: string, url: string) {
    const manual = this.#logins.get(id)?.manual;
    if (manual === undefined) throw new Error("No sign-in is waiting for a redirect URL");
    manual(url);
  }

  cancel(id: string) {
    this.#logins.get(id)?.abort.abort();
    this.#forget(id);
  }

  close() {
    for (const id of this.#logins.keys()) this.cancel(id);
  }

  #forget(id: string) {
    const login = this.#logins.get(id);
    if (login === undefined) return;
    clearTimeout(login.timer);
    this.#logins.delete(id);
  }

  #run(id: string): Login {
    const abort = new AbortController();
    const login: Login = {
      abort,
      state: { status: "pending" },
      timer: setTimeout(() => abort.abort(), LOGIN_TIMEOUT_MS),
    };
    this.#logins.set(id, login);

    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (event) => {
        if (event.type === "auth_url") login.state = { status: "pending", url: event.url };
      },
      prompt: (prompt) => {
        if (prompt.type !== "manual_code") {
          return Promise.reject(new Error(`Unsupported login prompt: ${prompt.type}`));
        }
        return new Promise<string>((resolve, reject) => {
          login.manual = resolve;
          prompt.signal?.addEventListener("abort", () => reject(new Error("Prompt closed")), {
            once: true,
          });
        });
      },
    };

    // A throwaway catalog: the credential is handed to `complete`, which stores it for the person who signed in.
    const models = createModels({
      credentials: new InMemoryCredentialStore(),
      authContext: NO_AMBIENT_AUTH,
    });
    models.setProvider(openaiProvider());
    models
      .login(CHATGPT_PROVIDER, "oauth", interaction, {
        getDeviceId: () => this.#deviceId,
        agentName: "pibot",
      })
      .then((credential) => this.#complete(credential))
      .then(
        (token) => {
          login.state = { status: "signed_in", token };
        },
        (error: unknown) => {
          login.state = abort.signal.aborted
            ? { status: "error", error: "Sign-in cancelled" }
            : { status: "error", error: message(error) };
        },
      )
      .finally(() => {
        login.manual = undefined;
        clearTimeout(login.timer);
      });
    return login;
  }
}
