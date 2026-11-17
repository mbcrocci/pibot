import * as React from "react";
import {
  CableIcon,
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  PlugIcon,
  PlusIcon,
  Trash2Icon,
  UnplugIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  type Access,
  type AgentSummary,
  connectConnector,
  type Connector,
  type ConnectorKind,
  type ConnectorPreset,
  createConnector,
  disconnectConnector,
  fetchConnectors,
  removeConnector,
  updateConnector,
} from "@/lib/api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const KIND_LABELS: Record<ConnectorKind, string> = {
  mcp: "MCP server",
  api: "HTTP API",
  inbound: "Inbound messages",
};

const STATE_LABELS: Record<Connector["status"]["state"], string> = {
  ready: "Ready",
  unconfigured: "Needs setup",
  disconnected: "Not connected",
  authorizing: "Waiting for sign-in",
  connecting: "Connecting",
  connected: "Connected",
  error: "Error",
};

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The person's connectors, opened from the sidebar: MCP servers, HTTP APIs, and inbound message endpoints. The person
 * adds them, signs in, and grants each agent read or write access; agents cannot grant themselves anything.
 */
export function Connectors({
  open,
  onOpenChange,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly AgentSummary[];
}) {
  const [data, setData] = React.useState<{ connectors: Connector[]; presets: ConnectorPreset[] }>();
  const [error, setError] = React.useState<string>();
  const [adding, setAdding] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setData(await fetchConnectors());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  React.useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // Follow sign-ins and connections in progress.
  const pending = data?.connectors.some(
    (item) => item.status.state === "authorizing" || item.status.state === "connecting",
  );
  React.useEffect(() => {
    if (!open || !pending) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [open, pending, reload]);

  const replace = (next: Connector) =>
    setData(
      (current) =>
        current && {
          ...current,
          connectors: current.connectors.some((item) => item.id === next.id)
            ? current.connectors.map((item) => (item.id === next.id ? next : item))
            : [...current.connectors, next],
        },
    );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Connectors</SheetTitle>
          <SheetDescription>
            Connect your agents to outside services: MCP servers, HTTP APIs, and messages from
            elsewhere. Only you grant access. Read access offers an agent only the tools that change
            nothing; write access offers the rest, which agents confirm with you before using.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data?.connectors.length === 0 && !adding && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No connectors yet.
            </p>
          )}
          {data?.connectors.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              agents={agents}
              onChange={replace}
              onRemoved={() => void reload()}
              onError={setError}
            />
          ))}
          {adding ? (
            <AddConnector
              presets={data?.presets ?? []}
              taken={new Set(data?.connectors.map((item) => item.preset).filter(Boolean))}
              agents={agents}
              onAdded={(connector) => {
                replace(connector);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add connector
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatusBadge({ status }: { status: Connector["status"] }) {
  const tone =
    status.state === "connected" || status.state === "ready"
      ? "bg-emerald-500"
      : status.state === "error" || status.state === "unconfigured"
        ? "bg-destructive"
        : "bg-muted-foreground";
  const busy = status.state === "authorizing" || status.state === "connecting";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {busy ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : (
        <span className={`size-2 rounded-full ${tone}`} />
      )}
      {STATE_LABELS[status.state]}
      {status.tools && ` · ${status.tools.read} read, ${status.tools.write} write tools`}
    </span>
  );
}

function ConnectorCard({
  connector,
  agents,
  onChange,
  onRemoved,
  onError,
}: {
  connector: Connector;
  agents: readonly AgentSummary[];
  onChange: (connector: Connector) => void;
  onRemoved: () => void;
  onError: (error: string | undefined) => void;
}) {
  const [confirm, setConfirm] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const { status } = connector;

  const run = async (action: () => Promise<Connector>) => {
    onError(undefined);
    try {
      const next = await action();
      onChange(next);
      return next;
    } catch (cause) {
      onError(errorText(cause));
      return undefined;
    }
  };

  async function connect() {
    const next = await run(() => connectConnector(connector.id));
    if (next?.status.authorizationUrl) window.open(next.status.authorizationUrl, "_blank");
  }

  async function remove() {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    try {
      await removeConnector(connector.id);
      onRemoved();
    } catch (cause) {
      onError(errorText(cause));
    }
  }

  const setGrant = (agentId: number, access: Access | "none") =>
    void run(() =>
      updateConnector(connector.id, {
        grants: { ...connector.grants, [agentId]: access === "none" ? null : access },
      }),
    );

  const usesHeaders =
    connector.kind === "api" || (connector.kind === "mcp" && connector.config.auth === "headers");

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{connector.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {KIND_LABELS[connector.kind]}
            {connector.config.url && ` · ${connector.config.url}`}
            {connector.config.baseUrl && ` · ${connector.config.baseUrl}`}
            {connector.kind !== "inbound" && ` · tools ${connector.slug}__…`}
          </span>
          <StatusBadge status={status} />
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          {connector.kind === "mcp" && status.state !== "unconfigured" && (
            <>
              {status.state === "connected" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void run(() => disconnectConnector(connector.id))}
                >
                  <UnplugIcon />
                  Disconnect
                </Button>
              ) : status.state === "authorizing" && status.authorizationUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(status.authorizationUrl, "_blank")}
                >
                  <PlugIcon />
                  Sign in
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status.state === "connecting"}
                  onClick={() => void connect()}
                >
                  <PlugIcon />
                  Connect
                </Button>
              )}
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            <Trash2Icon />
            {confirm ? "Remove?" : <span className="sr-only">Remove</span>}
          </Button>
        </div>
      </div>

      {status.error && <p className="text-sm text-destructive">{status.error}</p>}

      {connector.kind === "inbound" ? (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            Delivers to
            <select
              className={selectClass}
              value={connector.config.agentId}
              onChange={(event) =>
                void run(() =>
                  updateConnector(connector.id, {
                    config: { agentId: Number(event.target.value) },
                  }),
                )
              }
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          {connector.inboundUrl && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                POST a message (plain text, or JSON with <code>text</code>) to this URL. Keep it
                secret: it is the only credential.
              </span>
              <div className="flex gap-1">
                <Input readOnly value={connector.inboundUrl} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(connector.inboundUrl!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Access</span>
          {agents.map((agent) => (
            <label key={agent.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{agent.name}</span>
              <select
                className={selectClass}
                value={connector.grants[agent.id] ?? "none"}
                onChange={(event) => setGrant(agent.id, event.target.value as Access | "none")}
              >
                <option value="none">No access</option>
                <option value="read">Read</option>
                <option value="write">Read & write</option>
              </select>
            </label>
          ))}
        </div>
      )}

      {usesHeaders && <HeaderEditor connector={connector} onSave={run} />}
    </div>
  );
}

/** Sets or clears one secret header, such as `Authorization`; values are never shown again. */
function HeaderEditor({
  connector,
  onSave,
}: {
  connector: Connector;
  onSave: (action: () => Promise<Connector>) => Promise<Connector | undefined>;
}) {
  const [name, setName] = React.useState("Authorization");
  const [value, setValue] = React.useState("");
  const save = async (headers: Record<string, string>) => {
    if (await onSave(() => updateConnector(connector.id, { headers }))) setValue("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        Secret headers{connector.headers.length > 0 && `: ${connector.headers.join(", ")}`}
      </span>
      <div className="flex gap-1">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-40"
          placeholder="Header"
        />
        <Input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Value, such as Bearer …"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={name.trim() === "" || value === ""}
          onClick={() => void save({ [name.trim()]: value })}
        >
          Set
        </Button>
        {connector.headers.includes(name.trim()) && (
          <Button variant="ghost" size="sm" onClick={() => void save({ [name.trim()]: "" })}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

type Draft = {
  choice: string;
  name: string;
  url: string;
  auth: "oauth" | "headers" | "none";
  clientId: string;
  instructions: string;
  agentId: string;
  headerName: string;
  headerValue: string;
};

function AddConnector({
  presets,
  taken,
  agents,
  onAdded,
  onCancel,
}: {
  presets: readonly ConnectorPreset[];
  /** Presets already added. */
  taken: ReadonlySet<string | undefined>;
  agents: readonly AgentSummary[];
  onAdded: (connector: Connector) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<Draft>({
    choice: presets.find((preset) => !taken.has(preset.id))?.id ?? "mcp",
    name: "",
    url: "",
    auth: "oauth",
    clientId: "",
    instructions: "",
    agentId: String(agents[0]?.id ?? ""),
    headerName: "Authorization",
    headerValue: "",
  });
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const set = (field: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));

  const preset = presets.find((item) => item.id === draft.choice);
  const kind = (preset ? "mcp" : draft.choice) as ConnectorKind;
  const headers =
    draft.headerValue !== "" && draft.headerName.trim() !== ""
      ? { headers: { [draft.headerName.trim()]: draft.headerValue } }
      : {};

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const instructions = draft.instructions.trim() ? { instructions: draft.instructions } : {};
      onAdded(
        await createConnector(
          preset
            ? { preset: preset.id }
            : kind === "mcp"
              ? {
                  kind,
                  name: draft.name,
                  config: {
                    url: draft.url,
                    auth: draft.auth,
                    ...(draft.clientId.trim() ? { clientId: draft.clientId.trim() } : {}),
                    ...instructions,
                  },
                  ...(draft.auth === "headers" ? headers : {}),
                }
              : kind === "api"
                ? {
                    kind,
                    name: draft.name,
                    config: { baseUrl: draft.url, ...instructions },
                    ...headers,
                  }
                : { kind, name: draft.name, config: { agentId: Number(draft.agentId) } },
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="flex flex-col gap-3 rounded-md border border-dashed p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <CableIcon className="size-4" />
        New connector
      </div>
      <div className="flex flex-wrap gap-1">
        {presets
          .filter((item) => !taken.has(item.id))
          .map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={draft.choice === item.id ? "secondary" : "ghost"}
              onClick={() => setDraft((current) => ({ ...current, choice: item.id }))}
            >
              {item.name}
            </Button>
          ))}
        {(["mcp", "api", "inbound"] as const).map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={draft.choice === item ? "secondary" : "ghost"}
            onClick={() => setDraft((current) => ({ ...current, choice: item }))}
          >
            {KIND_LABELS[item]}
          </Button>
        ))}
      </div>

      {preset ? (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{preset.description}</span>
          {preset.setup && <span className="text-destructive">{preset.setup}</span>}
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-sm">
            Name
            <Input value={draft.name} onChange={set("name")} maxLength={40} required />
          </label>
          {kind !== "inbound" && (
            <label className="flex flex-col gap-1.5 text-sm">
              {kind === "mcp" ? "Server URL" : "Base URL"}
              <Input
                value={draft.url}
                onChange={set("url")}
                placeholder={
                  kind === "mcp" ? "https://example.com/mcp" : "https://api.example.com/v1"
                }
                required
              />
            </label>
          )}
          {kind === "mcp" && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              Authentication
              <select className={selectClass} value={draft.auth} onChange={set("auth")}>
                <option value="oauth">Sign in (OAuth)</option>
                <option value="headers">Secret header, such as an API key</option>
                <option value="none">None</option>
              </select>
              {draft.auth === "oauth" && (
                <Input
                  value={draft.clientId}
                  onChange={set("clientId")}
                  placeholder="OAuth client ID, if the server needs one"
                  className="flex-1"
                />
              )}
            </div>
          )}
          {(kind === "api" || (kind === "mcp" && draft.auth === "headers")) && (
            <div className="flex gap-1">
              <Input value={draft.headerName} onChange={set("headerName")} className="w-40" />
              <Input
                type="password"
                value={draft.headerValue}
                onChange={set("headerValue")}
                placeholder="Value, such as Bearer …"
              />
            </div>
          )}
          {kind === "inbound" && (
            <label className="flex items-center gap-2 text-sm">
              Delivers to
              <select className={selectClass} value={draft.agentId} onChange={set("agentId")}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind !== "inbound" && (
            <label className="flex flex-col gap-1.5 text-sm">
              Notes for agents
              <Textarea
                value={draft.instructions}
                onChange={set("instructions")}
                placeholder="What it is for and how to use it well."
                className="min-h-16"
              />
            </label>
          )}
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Add
        </Button>
      </div>
    </form>
  );
}
