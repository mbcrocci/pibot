import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  BriefcaseIcon,
  CableIcon,
  ChevronsUpDownIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PlusIcon,
} from "lucide-react";

import { AgentDialog } from "@/components/agent-dialog";
import { Connectors } from "@/components/connectors";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { AgentRole, AgentSummary, Me } from "@/lib/api";

export type AgentStatus = "working" | "done" | undefined;

const SEEN_KEY = "pibot:seen";

export function AgentIcon({ role }: { role: AgentRole }) {
  return role === "chief" ? <BriefcaseIcon /> : <BotIcon />;
}

/**
 * The newest entry the person has seen of each agent, kept in localStorage. An agent is done when it finished a turn
 * the person has not looked at, such as one a teammate asked for; one this browser has never seen counts as seen.
 */
function useStatuses(agents: AgentSummary[] | undefined, activeId: number | undefined) {
  const [seen, setSeen] = React.useState<Record<number, number>>();

  React.useEffect(() => {
    try {
      setSeen(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<number, number>);
    } catch {
      setSeen({});
    }
  }, []);

  React.useEffect(() => {
    if (seen === undefined || agents === undefined) return;
    let changed = false;
    const next = { ...seen };
    for (const { id, lastEntryId } of agents) {
      const known = next[id];
      if (known === undefined || (id === activeId && known < lastEntryId)) {
        next[id] = lastEntryId;
        changed = true;
      }
    }
    if (!changed) return;
    setSeen(next);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  }, [agents, activeId, seen]);

  return (agent: AgentSummary): AgentStatus => {
    if (agent.working) return "working";
    const known = seen?.[agent.id];
    return agent.id !== activeId && known !== undefined && agent.lastEntryId > known
      ? "done"
      : undefined;
  };
}

export function AgentSidebar({
  agents,
  activeId,
  me,
  onCreated,
  onSignOut,
}: {
  /** Undefined while loading. */
  agents: AgentSummary[] | undefined;
  activeId: number | undefined;
  me: Me;
  onCreated: (agent: AgentSummary) => void;
  onSignOut: () => void;
}) {
  const statusOf = useStatuses(agents, activeId);
  const [creating, setCreating] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1">
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">pibot</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupAction title="New agent" onClick={() => setCreating(true)}>
            <PlusIcon />
            <span className="sr-only">New agent</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents === undefined
                ? Array.from({ length: 3 }, (_, index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                : agents.map((agent) => (
                    <SidebarMenuItem key={agent.id}>
                      <SidebarMenuButton
                        render={<Link to="/" search={{ a: agent.id }} />}
                        isActive={agent.id === activeId}
                        tooltip={agent.description}
                      >
                        <AgentIcon role={agent.role} />
                        <span className="truncate">{agent.name}</span>
                        <StatusIndicator status={statusOf(agent)} />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setConnecting(true)}>
              <CableIcon />
              <span>Connectors</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <div className="flex min-w-0 flex-col text-left">
                  <span className="truncate font-medium">{me.name ?? me.email ?? "Signed in"}</span>
                  {me.name && me.email && (
                    <span className="truncate text-xs text-muted-foreground">{me.email}</span>
                  )}
                </div>
                <ChevronsUpDownIcon className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    Signed in with ChatGPT
                    <div className="font-normal text-muted-foreground">
                      Your agents keep working after you sign out.
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      <AgentDialog open={creating} onOpenChange={setCreating} onSaved={onCreated} />
      <Connectors open={connecting} onOpenChange={setConnecting} agents={agents ?? []} />
    </Sidebar>
  );
}

function StatusIndicator({ status }: { status: AgentStatus }) {
  if (status === "working") {
    return (
      <span className="ml-auto flex shrink-0 items-center" title="Working">
        <LoaderCircleIcon className="animate-spin text-muted-foreground" />
        <span className="sr-only">Working</span>
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="ml-auto flex size-4 shrink-0 items-center justify-center" title="New reply">
        <span className="size-2 rounded-full bg-blue-500" />
        <span className="sr-only">New reply</span>
      </span>
    );
  }
  return null;
}
