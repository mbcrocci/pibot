import * as React from "react";
import { BotIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cancelLogin,
  type LoginStatus,
  loginStatus,
  startLogin,
  submitLoginRedirect,
} from "@/lib/api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The signed-out page: Sign in with ChatGPT is the only way in, and creates the account on first use. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [login, setLogin] = React.useState<LoginStatus>({ status: "idle" });
  const [error, setError] = React.useState<string>();
  const [redirect, setRedirect] = React.useState("");
  const pending = login.status === "pending";

  // Poll while the person signs in, in the other tab.
  React.useEffect(() => {
    if (!pending) return;
    const interval = setInterval(() => {
      void loginStatus().then(
        (next) => {
          if (next.status === "signed_in") onSignedIn();
          else if (next.status === "error") setError(next.error);
          if (next.status !== "pending" || next.url !== undefined) setLogin(next);
        },
        (cause) => setError(errorText(cause)),
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [pending, onSignedIn]);

  async function signIn() {
    setError(undefined);
    setRedirect("");
    // Open the tab inside the click so popup blockers allow it; it gets its URL once the server has one.
    const tab = window.open("about:blank", "_blank");
    setLogin({ status: "pending" });
    try {
      const { url } = await startLogin();
      if (tab) tab.location.href = url;
      setLogin({ status: "pending", url });
    } catch (cause) {
      tab?.close();
      setLogin({ status: "idle" });
      setError(errorText(cause));
    }
  }

  async function submitRedirect(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await submitLoginRedirect(redirect.trim());
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function cancel() {
    setLogin(await cancelLogin());
  }

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <BotIcon className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold">pibot</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Your Chief of Staff and a team of agents that work together for you. They run on your
            ChatGPT subscription.
          </p>
        </div>

        {pending ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Waiting for you to finish signing in…
            </div>
            {login.url && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                nativeButton={false}
                render={<a href={login.url} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon />
                Open the sign-in page
              </Button>
            )}
            <form onSubmit={(event) => void submitRedirect(event)} className="flex flex-col gap-2">
              <label htmlFor="chatgpt-redirect" className="text-muted-foreground">
                If the page doesn't finish on its own, paste the address it ended on:
              </label>
              <div className="flex gap-2">
                <Input
                  id="chatgpt-redirect"
                  value={redirect}
                  onChange={(event) => setRedirect(event.target.value)}
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                />
                <Button type="submit" variant="secondary" disabled={redirect.trim() === ""}>
                  Submit
                </Button>
              </div>
            </form>
            <Button variant="ghost" className="self-start" onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="lg" onClick={() => void signIn()}>
            Continue with ChatGPT
          </Button>
        )}

        {error && <p className="text-center text-sm text-destructive">{error}</p>}
      </div>
    </main>
  );
}
