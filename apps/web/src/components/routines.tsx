import * as React from "react";
import {
  AlarmClockIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentSummary,
  createRoutine,
  fetchRoutines,
  removeRoutine,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  runRoutine,
  updateRoutine,
} from "@/lib/api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How often the open panel refreshes, so run results show up without reopening it. */
const REFRESH_MS = 5000;

const SCHEDULES = [
  { label: "Weekdays at 9:00", schedule: "0 9 * * 1-5" },
  { label: "Every day at 9:00", schedule: "0 9 * * *" },
  { label: "Mondays at 9:00", schedule: "0 9 * * 1" },
  { label: "Every hour", schedule: "0 * * * *" },
];

const STATUS_LABELS: Record<RoutineRun["status"], string> = {
  firing: "Starting",
  queued: "Running",
  done: "Answered",
  unanswered: "Not answered",
  skipped: "Skipped",
};

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const formatTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const describeSchedule = (schedule: string) =>
  SCHEDULES.find((item) => item.schedule === schedule)?.label ?? schedule;

/**
 * Header button that opens an agent's routines: prompts it receives on a schedule, read in a time zone, with the
 * results of their latest runs. Agents can set routines up too; the panel shows who did.
 */
export function Routines({ agent, agents }: { agent: AgentSummary; agents: AgentSummary[] }) {
  const [open, setOpen] = React.useState(false);
  const [routines, setRoutines] = React.useState<Routine[]>();
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const reload = React.useCallback(async () => {
    setRoutines(await fetchRoutines());
  }, []);

  React.useEffect(() => {
    void reload().catch((cause: unknown) => setError(errorText(cause)));
  }, [reload, agent.id]);

  React.useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void reload().catch(() => {}), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, reload]);

  const own = routines?.filter((routine) => routine.agentId === agent.id);
  const nameOf = (by: "person" | number) =>
    by === "person" ? "you" : (agents.find((item) => item.id === by)?.name ?? "a removed agent");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void reload().catch(() => {});
        else setAdding(false);
      }}
    >
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <AlarmClockIcon />
        Routines
        {own !== undefined && own.length > 0 && (
          <span className="text-muted-foreground">{own.length}</span>
        )}
      </SheetTrigger>
      <SheetContent className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Routines</SheetTitle>
          <SheetDescription>
            Prompts {agent.name} receives on a schedule. Answers appear in its conversation. A
            routine set up by an agent cannot take actions with outside effects without your
            confirmation.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {own?.length === 0 && !adding && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No routines yet. Add one here, or ask an agent to set one up.
            </p>
          )}
          {own?.map((routine) => (
            <RoutineItem
              key={routine.id}
              routine={routine}
              setBy={nameOf(routine.createdBy)}
              onChange={reload}
              onError={setError}
            />
          ))}
          {adding ? (
            <AddRoutine
              agent={agent}
              onAdded={async () => {
                setAdding(false);
                await reload();
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
              <PlusIcon />
              New routine
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RoutineItem({
  routine,
  setBy,
  onChange,
  onError,
}: {
  routine: Routine;
  setBy: string;
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const running = routine.runs.some((run) => run.status === "firing" || run.status === "queued");

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    onError(undefined);
    try {
      await action();
      await onChange();
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-start gap-2 p-3 text-left">
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{routine.name}</span>
          <span className="text-sm text-muted-foreground">
            {describeSchedule(routine.schedule)} · {routine.timeZone}
          </span>
        </span>
        <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground">
          {running
            ? "Running"
            : routine.enabled
              ? routine.nextRunAt
                ? `Next ${formatTime(routine.nextRunAt, routine.timeZone)}`
                : ""
              : "Paused"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t px-4 py-3">
        <p className="text-sm whitespace-pre-wrap">{routine.prompt}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{routine.schedule}</span> · Set up by {setBy}
        </p>
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Latest runs</h4>
          {routine.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not run yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {routine.runs
                .slice()
                .reverse()
                .map((run) => (
                  <li key={`${run.trigger}:${run.scheduledFor}`} className="flex gap-2">
                    <span className="w-36 shrink-0 text-muted-foreground">
                      {formatTime(run.scheduledFor, routine.timeZone)}
                    </span>
                    <span
                      className={
                        run.status === "unanswered" ? "text-destructive" : "text-foreground"
                      }
                    >
                      {STATUS_LABELS[run.status]}
                      {run.trigger === "manual" && " · started by hand"}
                      {run.missed ? ` · ${run.missed} earlier missed while offline` : ""}
                      {run.reason ? ` · ${run.reason}` : ""}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || running}
            onClick={() => void act(() => runRoutine(routine.id))}
          >
            <ZapIcon />
            Run now
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => updateRoutine(routine.id, { enabled: !routine.enabled }))}
          >
            {routine.enabled ? <PauseIcon /> : <PlayIcon />}
            {routine.enabled ? "Pause" : "Resume"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => (confirm ? void act(() => removeRoutine(routine.id)) : setConfirm(true))}
          >
            <Trash2Icon />
            {confirm ? `Remove ${routine.name}?` : "Remove"}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AddRoutine({
  agent,
  onAdded,
  onCancel,
}: {
  agent: AgentSummary;
  onAdded: () => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<RoutineDraft>({
    name: "",
    prompt: "",
    schedule: SCHEDULES[0]!.schedule,
    timeZone: browserTimeZone(),
  });
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const set =
    (key: keyof RoutineDraft) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await createRoutine(agent.id, draft);
      await onAdded();
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
        <AlarmClockIcon className="size-4" />
        New routine for {agent.name}
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        Name
        <Input
          value={draft.name}
          onChange={set("name")}
          maxLength={60}
          placeholder="Morning briefing"
          required
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Prompt
        <Textarea
          value={draft.prompt}
          onChange={set("prompt")}
          placeholder="What it should do each time, with everything it needs to know."
          className="min-h-24"
          required
        />
      </label>
      <div className="flex flex-col gap-1.5 text-sm">
        Schedule
        <div className="flex flex-wrap gap-1">
          {SCHEDULES.map((item) => (
            <Button
              key={item.schedule}
              type="button"
              size="sm"
              variant={draft.schedule === item.schedule ? "secondary" : "ghost"}
              onClick={() => setDraft((current) => ({ ...current, schedule: item.schedule }))}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          <Input
            value={draft.schedule}
            onChange={set("schedule")}
            className="font-mono"
            aria-label="Cron schedule"
            required
          />
          <Input
            value={draft.timeZone}
            onChange={set("timeZone")}
            className="w-56"
            aria-label="Time zone"
            required
          />
        </div>
        <span className="text-xs text-muted-foreground">
          Cron fields: minute, hour, day of month, month, day of week. At least 5 minutes apart.
        </span>
      </div>
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
