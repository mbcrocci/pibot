import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentDraft,
  type AgentSummary,
  createAgent,
  removeAgent,
  updateAgent,
} from "@/lib/api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const FIELD_LABELS: Record<string, string> = {
  created: "created",
  name: "name",
  description: "purpose",
  instructions: "instructions",
  model: "model",
};

/**
 * Creates a specialist, or edits an existing agent: its name, its one-line purpose, and the brief it works from. Any
 * agent can be renamed, the Chief of Staff too, which cannot be removed. An agent's recent changes show below.
 */
export function AgentDialog({
  open,
  onOpenChange,
  agent,
  agents = [],
  instructions = "",
  onSaved,
  onRemoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agent to edit; absent to create one. */
  agent?: AgentSummary;
  /** The team, to name the agents in the change history. */
  agents?: readonly AgentSummary[];
  /** The agent's current brief. */
  instructions?: string;
  onSaved?: (agent: AgentSummary) => void;
  onRemoved?: (agent: AgentSummary) => void;
}) {
  const [draft, setDraft] = React.useState<AgentDraft>({
    name: "",
    description: "",
    instructions: "",
  });
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const chief = agent?.role === "chief";

  // Start from the agent's current values each time the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setDraft({
      name: agent?.name ?? "",
      description: agent?.description ?? "",
      instructions: agent ? instructions : "",
    });
    setError(undefined);
    setConfirmRemove(false);
  }, [open, agent, instructions]);

  const set = (field: keyof AgentDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const saved = agent ? await updateAgent(agent.id, draft) : await createAgent(draft);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (agent === undefined) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    try {
      await removeAgent(agent.id);
      onRemoved?.(agent);
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{agent ? `Edit ${agent.name}` : "New agent"}</DialogTitle>
            <DialogDescription>
              {agent
                ? "Changes apply from the agent's next answer."
                : "A specialist on your team. Your Chief of Staff can also create agents for you: just ask."}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1.5 text-sm">
            Name
            <Input
              value={draft.name}
              onChange={set("name")}
              placeholder={chief ? "Chief of Staff" : "Researcher"}
              maxLength={40}
              required
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Purpose
            <Input
              value={draft.description}
              onChange={set("description")}
              placeholder="Finds and summarizes sources on any topic."
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Instructions
            <Textarea
              value={draft.instructions}
              onChange={set("instructions")}
              placeholder="You research topics thoroughly and cite your sources…"
              className="max-h-72 min-h-32"
            />
          </label>

          {agent?.changes && agent.changes.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Revision {agent.revision ?? 1} · {agent.changes.length}{" "}
                {agent.changes.length === 1 ? "change" : "changes"}
              </summary>
              <ol className="mt-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                {agent.changes
                  .slice()
                  .reverse()
                  .map((change) => (
                    <li key={change.revision} className="flex flex-col">
                      <span>
                        <span className="text-muted-foreground">#{change.revision}</span>{" "}
                        {change.fields.map((field) => FIELD_LABELS[field] ?? field).join(", ")} by{" "}
                        {change.by === "person"
                          ? "you"
                          : (agents.find((item) => item.id === change.by)?.name ??
                            "a former agent")}
                        <span className="text-muted-foreground">
                          {" "}
                          · {new Date(change.at).toLocaleString()}
                        </span>
                      </span>
                      {change.reason && (
                        <span className="text-muted-foreground">{change.reason}</span>
                      )}
                    </li>
                  ))}
              </ol>
            </details>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="sm:justify-between">
            {agent && !chief ? (
              <Button type="button" variant="destructive" onClick={() => void remove()}>
                {confirmRemove ? `Remove ${agent.name}?` : "Remove"}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || draft.name.trim() === ""}>
                {agent ? "Save" : "Create"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
