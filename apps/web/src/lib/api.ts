import * as React from "react";
import type { ConversationView } from "@earendil-works/pi-durable";

/** A request the server refused because the session is missing or expired. */
export class SignedOut extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    const message = body?.error ?? `Request failed with ${response.status}`;
    throw response.status === 401 ? new SignedOut(message) : new Error(message);
  }
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type ModelRef = { provider: string; modelId: string };
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelChoice = { model: ModelRef; thinkingLevel: ThinkingLevel };

/** Mirrors `CatalogEntry` in apps/server/src/models.ts. */
export type CatalogModel = ModelRef & {
  name: string;
  thinkingLevels: ThinkingLevel[];
  available: boolean;
};

export type ModelCatalog = { models: CatalogModel[]; default?: ModelChoice };

export const fetchModels = () => request<ModelCatalog>("/models");

/** The signed-in person; mirrors `GET /me` in apps/server/src/app.ts. */
export type Me = { email: string | null; name: string | null };

/** Mirrors `LoginStatus` in apps/server/src/auth.ts, without the session token the cookie carries. */
export type LoginStatus =
  | { status: "idle" }
  | { status: "pending"; url?: string }
  | { status: "error"; error: string }
  | { status: "signed_in" };

export const startLogin = () => request<{ url: string }>("/auth/login", { method: "POST" });
export const loginStatus = () => request<LoginStatus>("/auth/login");
export const submitLoginRedirect = (url: string) =>
  request<LoginStatus>("/auth/login/redirect", { method: "POST", ...json({ url }) });
export const cancelLogin = () => request<LoginStatus>("/auth/login/cancel", { method: "POST" });
export const signOut = () => request<{ ok: true }>("/auth/logout", { method: "POST" });

/**
 * The signed-in person: undefined while checking, null when signed out. `reload` checks again, such as after a
 * sign-in completes.
 */
export function useMe() {
  const [me, setMe] = React.useState<Me | null>();

  const reload = React.useCallback(async () => {
    try {
      setMe(await request<Me>("/me"));
    } catch (error) {
      if (error instanceof SignedOut) setMe(null);
      else throw error;
    }
  }, []);

  React.useEffect(() => {
    void reload().catch(() => setMe(null));
  }, [reload]);

  return { me, reload, setMe };
}

export type AgentRole = "chief" | "specialist";

/** One change to an agent; mirrors `AgentChange` in apps/server/src/team.ts. */
export type AgentChange = {
  revision: number;
  at: string;
  /** The person, or the ID of the agent that made the change. */
  by: "person" | number;
  reason?: string;
  fields: string[];
};

/** Mirrors `AgentSummary` in apps/server/src/workspace.ts. */
export type AgentSummary = {
  id: number;
  name: string;
  description: string;
  role: AgentRole;
  revision?: number;
  changes?: AgentChange[];
  working: boolean;
  lastEntryId: number;
};

export type AgentDraft = { name: string; description: string; instructions: string };

export const createAgent = (draft: AgentDraft) =>
  request<AgentSummary>("/agents", { method: "POST", ...json(draft) });

export const updateAgent = (id: number, changes: Partial<AgentDraft> | ModelChoice) =>
  request<AgentSummary>(`/agents/${id}`, { method: "PATCH", ...json(changes) });

/** The person's skills, for every agent, or one agent's own. */
export type SkillOwner = { kind: "person" } | { kind: "agent"; agentId: number };

/** Mirrors `SkillSummary` in apps/server/src/skills.ts. */
export type SkillSummary = {
  name: string;
  description: string;
  scope: SkillOwner["kind"];
  /** Every file but SKILL.md. */
  files: string[];
};

export type Skill = SkillSummary & { content: Record<string, string> };

const skillsPath = (owner: SkillOwner) =>
  owner.kind === "person" ? "/skills" : `/agents/${owner.agentId}/skills`;

export const fetchSkills = (owner: SkillOwner) => request<SkillSummary[]>(skillsPath(owner));

export const fetchSkill = (owner: SkillOwner, name: string) =>
  request<Skill>(`${skillsPath(owner)}/${encodeURIComponent(name)}`);

/** Installs a skill from a zip archive, or from a folder's files by path; replaces the skill of the same name. */
export const uploadSkill = (owner: SkillOwner, upload: Blob | Record<string, string>) =>
  request<SkillSummary>(
    skillsPath(owner),
    upload instanceof Blob
      ? { method: "POST", headers: { "content-type": "application/zip" }, body: upload }
      : { method: "POST", ...json({ files: upload }) },
  );

export const removeSkill = (owner: SkillOwner, name: string) =>
  request<{ ok: true }>(`${skillsPath(owner)}/${encodeURIComponent(name)}`, { method: "DELETE" });

/** One run of a routine; mirrors `RoutineRun` in apps/server/src/routines.ts. */
export type RoutineRun = {
  trigger: "schedule" | "manual";
  scheduledFor: string;
  firedAt: string;
  status: "firing" | "queued" | "done" | "unanswered" | "skipped";
  missed?: number;
  answer?: number;
  reason?: string;
  settledAt?: string;
};

/** Mirrors `RoutineSummary` in apps/server/src/routines.ts. */
export type Routine = {
  id: string;
  agentId: number;
  name: string;
  prompt: string;
  schedule: string;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  /** The person, or the ID of the agent that set it up. */
  createdBy: "person" | number;
  promptBy: "person" | number;
  runs: RoutineRun[];
  nextRunAt?: string;
};

export type RoutineDraft = {
  name: string;
  prompt: string;
  schedule: string;
  timeZone: string;
  enabled?: boolean;
};

export const fetchRoutines = () => request<Routine[]>("/routines");

export const createRoutine = (agentId: number, draft: RoutineDraft) =>
  request<Routine>("/routines", { method: "POST", ...json({ agentId, ...draft }) });

export const updateRoutine = (id: string, changes: Partial<RoutineDraft>) =>
  request<Routine>(`/routines/${id}`, { method: "PATCH", ...json(changes) });

export const removeRoutine = (id: string) =>
  request<{ ok: true }>(`/routines/${id}`, { method: "DELETE" });

export const runRoutine = (id: string) =>
  request<RoutineRun>(`/routines/${id}/run`, { method: "POST" });

export type Access = "read" | "write";
export type ConnectorKind = "mcp" | "api" | "inbound";

/** Mirrors `ConnectorView` in apps/server/src/connectors.ts. */
export type Connector = {
  id: string;
  kind: ConnectorKind;
  name: string;
  slug: string;
  preset?: string;
  config: {
    url?: string;
    auth?: "oauth" | "headers" | "none";
    clientId?: string;
    baseUrl?: string;
    agentId?: number;
    instructions?: string;
  };
  /** Agent ID → access. */
  grants: Record<string, Access>;
  status: {
    state:
      | "ready"
      | "unconfigured"
      | "disconnected"
      | "authorizing"
      | "connecting"
      | "connected"
      | "error";
    error?: string;
    authorizationUrl?: string;
    tools?: { read: number; write: number };
  };
  /** Names of the headers that are set; their values never leave the server. */
  headers: string[];
  inboundUrl?: string;
};

export type ConnectorPreset = { id: string; name: string; description: string; setup?: string };

export const fetchConnectors = () =>
  request<{ connectors: Connector[]; presets: ConnectorPreset[] }>("/connectors");

export const createConnector = (input: {
  preset?: string;
  kind?: ConnectorKind;
  name?: string;
  config?: Connector["config"];
  headers?: Record<string, string>;
}) => request<Connector>("/connectors", { method: "POST", ...json(input) });

export const updateConnector = (
  id: string,
  changes: {
    name?: string;
    config?: Connector["config"];
    headers?: Record<string, string>;
    grants?: Record<string, Access | null>;
  },
) => request<Connector>(`/connectors/${id}`, { method: "PATCH", ...json(changes) });

export const removeConnector = (id: string) =>
  request<{ ok: true }>(`/connectors/${id}`, { method: "DELETE" });

export const connectConnector = (id: string) =>
  request<Connector>(`/connectors/${id}/connect`, { method: "POST" });

export const disconnectConnector = (id: string) =>
  request<Connector>(`/connectors/${id}/disconnect`, { method: "POST" });

export const removeAgent = (id: number) =>
  request<{ ok: true }>(`/agents/${id}`, { method: "DELETE" });

export const stopAgent = (id: number) =>
  request<{ ok: true }>(`/agents/${id}/abort`, { method: "POST" });

export const sendMessage = (id: number, content: string) =>
  request<{ submissionId: number }>(`/agents/${id}/messages`, {
    method: "POST",
    ...json({ content, requestId: crypto.randomUUID() }),
  });

/** The person's agents, the Chief of Staff first, following the server as runs start and finish. */
export function useAgents() {
  const [agents, setAgents] = React.useState<AgentSummary[]>();

  React.useEffect(() => {
    const source = new EventSource("/api/agents/watch");
    source.addEventListener("agents", (event) => {
      setAgents(JSON.parse(event.data) as AgentSummary[]);
    });
    return () => source.close();
  }, []);

  return agents;
}

/** Follows an agent's conversation view over server-sent events; EventSource reconnects on its own. */
export function useAgentView(id: number | undefined) {
  const [state, setState] = React.useState<{
    id: number;
    view?: ConversationView;
    connected: boolean;
  }>();

  React.useEffect(() => {
    if (id === undefined) return;
    setState({ id, connected: false });
    const source = new EventSource(`/api/agents/${id}/view`);
    source.addEventListener("view", (event) => {
      setState({ id, view: JSON.parse(event.data) as ConversationView, connected: true });
    });
    source.onerror = () => setState((current) => current && { ...current, connected: false });
    return () => source.close();
  }, [id]);

  // Ignore a view left over from the previous agent.
  return state?.id === id ? state : undefined;
}
