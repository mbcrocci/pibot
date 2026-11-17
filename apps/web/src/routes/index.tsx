import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";

import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon, AgentSidebar } from "@/components/agent-sidebar";
import { Chat } from "@/components/chat";
import { ModelSelector } from "@/components/model-selector";
import { SignIn } from "@/components/sign-in";
import { Routines } from "@/components/routines";
import { Skills } from "@/components/skills";
import { SystemPrompt } from "@/components/system-prompt";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
  type AgentSummary,
  fetchModels,
  type Me,
  type ModelCatalog,
  type ModelChoice,
  sendMessage,
  signOut,
  stopAgent,
  updateAgent,
  useAgents,
  useAgentView,
  useMe,
} from "@/lib/api";
import { toSystemPrompt } from "@/lib/system-prompt";
import { toTranscript } from "@/lib/transcript";

type Search = { a?: number };

const sameChoice = (a: ModelChoice | undefined, b: ModelChoice | undefined) =>
  a?.model.provider === b?.model.provider &&
  a?.model.modelId === b?.model.modelId &&
  a?.thinkingLevel === b?.thinkingLevel;

type AgentDoc = Partial<ModelChoice> & { instructions?: string };

const CHIEF_SUGGESTIONS = [
  "What can you and your team do for me?",
  "Set me up with a research assistant",
  "Plan my week with me",
  "Create a writer who drafts in my voice",
];

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.a === "number" ? { a: search.a } : {},
  component: Home,
});

function Home() {
  const { me, reload, setMe } = useMe();
  const onSignedIn = React.useCallback(() => void reload(), [reload]);

  if (me === undefined) return null;
  if (me === null) return <SignIn onSignedIn={onSignedIn} />;
  return (
    <Workspace
      me={me}
      onSignOut={() => {
        void signOut().finally(() => setMe(null));
      }}
    />
  );
}

function Workspace({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const { a: selected } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const agents = useAgents();
  // Without a selection, or after the selected agent is removed, show the Chief of Staff.
  const agent: AgentSummary | undefined =
    agents?.find((item) => item.id === selected) ?? agents?.find((item) => item.role === "chief");
  const agentId = agent?.id;

  const live = useAgentView(agentId);
  const transcript = React.useMemo(() => toTranscript(live?.view), [live?.view]);
  const systemPrompt = React.useMemo(() => toSystemPrompt(live?.view), [live?.view]);
  const stored = live?.view?.docs["pi.agent"] as AgentDoc | undefined;
  const userTurns = transcript.turns.filter((turn) => turn.role === "user").length;

  // A sent message shows right away, until the transcript has a user turn for it.
  const [pending, setPending] = React.useState<{ agentId: number; text: string; after: number }>();
  const [error, setError] = React.useState<string>();
  const [editing, setEditing] = React.useState(false);
  const showPending =
    pending !== undefined && pending.agentId === agentId && userTurns <= pending.after;

  const [catalog, setCatalog] = React.useState<ModelCatalog>();
  React.useEffect(() => {
    void fetchModels().then(setCatalog, () => {});
  }, []);

  // The latest pick shows at once, until the agent's stored choice catches up.
  const [switching, setSwitching] = React.useState<ModelChoice>();
  const storedChoice =
    stored?.model && stored.thinkingLevel
      ? { model: stored.model, thinkingLevel: stored.thinkingLevel }
      : undefined;
  React.useEffect(() => {
    if (switching && sameChoice(switching, storedChoice)) setSwitching(undefined);
  }, [switching, storedChoice]);
  const choice = switching ?? storedChoice ?? catalog?.default;

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  async function onChoose(next: ModelChoice) {
    if (agentId === undefined) return;
    setSwitching(next);
    try {
      await updateAgent(agentId, next);
    } catch (cause) {
      setSwitching(undefined);
      fail(cause);
    }
  }

  async function onSend(text: string) {
    if (agentId === undefined) return;
    setError(undefined);
    setPending({ agentId, text, after: userTurns });
    try {
      await sendMessage(agentId, text);
    } catch (cause) {
      setPending(undefined);
      fail(cause);
    }
  }

  const select = (id: number) => void navigate({ search: { a: id } });
  const chief = agent?.role === "chief";

  return (
    <SidebarProvider>
      <AgentSidebar
        agents={agents}
        activeId={agentId}
        me={me}
        onCreated={(created) => select(created.id)}
        onSignOut={onSignOut}
      />
      <SidebarInset>
        {agent && (
          <Chat
            key={agent.id}
            title={agent.name}
            icon={<AgentIcon role={agent.role} />}
            empty={
              chief
                ? {
                    title: "Your Chief of Staff",
                    description:
                      "Tell it what you need. It answers, hands work to the right agent, and builds your team as you go.",
                  }
                : {
                    title: agent.name,
                    description: agent.description || "A specialist on your team.",
                  }
            }
            suggestions={chief ? CHIEF_SUGGESTIONS : []}
            placeholder={`Message ${agent.name}…`}
            transcript={transcript}
            pending={showPending ? pending.text : undefined}
            connected={live?.connected ?? false}
            onSend={(text) => void onSend(text)}
            onStop={() => void stopAgent(agent.id).catch(fail)}
            actions={
              <>
                <Skills agent={agent} />
                <Routines agent={agent} agents={agents ?? []} />
                <SystemPrompt prompt={systemPrompt} />
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <PencilIcon />
                  Edit
                </Button>
              </>
            }
            composerActions={
              catalog && choice ? (
                <ModelSelector
                  models={catalog.models}
                  value={choice}
                  onChange={(next) => void onChoose(next)}
                />
              ) : undefined
            }
          />
        )}
        {agent && (
          <AgentDialog
            open={editing}
            onOpenChange={setEditing}
            agent={agent}
            agents={agents}
            instructions={stored?.instructions ?? ""}
            onRemoved={() => void navigate({ search: {} })}
          />
        )}
        {error && (
          <div className="fixed inset-x-0 bottom-28 mx-auto w-fit rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
