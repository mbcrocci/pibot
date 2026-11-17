import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  type DocumentReader,
  type EntryId,
  type Harness,
  section,
  type SubmissionId,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { Cron } from "croner";
import { type AgentProfile, CHIEF_NAME, type ChangedBy, ROUTINE_MESSAGE } from "./team.ts";

/** Why a run fired: its schedule, or the person starting it by hand. */
export type RoutineTrigger = "schedule" | "manual";

/**
 * One run of a routine.
 *
 * - `firing`: about to be submitted. A run left in this state by a crash is submitted on the next start.
 * - `queued`: submitted to the agent and not answered yet.
 * - `done` / `unanswered`: the agent answered, or the submission ended without an answer.
 * - `skipped`: the previous run had not finished, so this slot was not submitted.
 */
export type RoutineRun = {
  trigger: RoutineTrigger;
  /** ISO timestamp of the slot this run is for, or of when the person started it. */
  scheduledFor: string;
  /** ISO timestamp. */
  firedAt: string;
  status: "firing" | "queued" | "done" | "unanswered" | "skipped";
  /** Earlier slots that passed without a run while the server was down. */
  missed?: number;
  submission?: SubmissionId;
  /** The agent's answer, in its conversation. */
  answer?: EntryId;
  reason?: string;
  /** ISO timestamp. */
  settledAt?: string;
};

/** A prompt an agent receives on a schedule. */
export type Routine = {
  id: string;
  /** The agent that runs it. */
  agentId: ConversationId;
  name: string;
  /** What the agent is asked each time. */
  prompt: string;
  /** A five-field cron expression, such as `0 9 * * 1-5`, or a nickname such as `@daily`. */
  schedule: string;
  /** IANA time zone the schedule is read in, such as `Europe/Lisbon`. */
  timeZone: string;
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  createdBy: ChangedBy;
  /** Who wrote the current prompt; an agent's prompt is framed as not coming from the person. */
  promptBy: ChangedBy;
  /** The tool call that created it, so a rerun after a crash finds it instead of failing on its name. */
  createdByTask?: string;
  /** ISO timestamp the schedule counts from: creation, or the last time it was enabled or rescheduled. */
  since: string;
  /** The latest runs, oldest first, at most `MAX_RUNS`. */
  runs: RoutineRun[];
};

/** A routine with when it next fires, for the person and the agents. */
export type RoutineSummary = Routine & { nextRunAt?: string | undefined };

/** Every routine on the person's team, in creation order. */
export const Routines = defineDoc<{ routines: Routine[] }>({
  kind: "pibot.routines",
  version: 1,
  scope: "session",
  initial: () => ({ routines: [] }),
});

/** `data` of a `ROUTINE_MESSAGE` entry. */
export type RoutineMessageData = {
  routineId: string;
  routineName: string;
  text: string;
  trigger: RoutineTrigger;
  scheduledFor: string;
};

/** How many routines one agent can have. */
export const MAX_ROUTINES = 50;
/** How many runs a routine keeps in its history. */
export const MAX_RUNS = 20;
/** The shortest time a schedule may leave between two runs. */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;
const NAME_LENGTH = 60;
const PROMPT_LENGTH = 8000;
/** The scheduler wakes at least this often, so a clock change or a sleeping machine cannot strand a routine. */
const MAX_SLEEP_MS = 60 * 60 * 1000;
/** Missed slots are counted up to here. */
const MAX_MISSED = 10_000;

/** A user-facing reason a routine cannot be created, changed, or run. */
export class RoutineError extends Error {}

const text = (value: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text: value }],
  isError,
});

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const runKey = (run: Pick<RoutineRun, "trigger" | "scheduledFor">) =>
  `${run.trigger}:${run.scheduledFor}`;

/** The request ID of a run's submission, so a resubmission after a crash finds the one already admitted. */
const requestId = (routine: Routine, run: RoutineRun) => `routine:${routine.id}:${runKey(run)}`;

const unsettled = (run: RoutineRun) => run.status === "firing" || run.status === "queued";

function checkTimeZone(timeZone: string) {
  const trimmed = timeZone.trim();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new RoutineError(
      `${trimmed || "An empty value"} is not a time zone. Use an IANA name such as Europe/Lisbon.`,
    );
  }
}

const cron = (schedule: string, timeZone: string) =>
  new Cron(schedule, { timezone: timeZone, paused: true });

/** A checked schedule: five cron fields or a nickname, at least `MIN_INTERVAL_MS` between runs. */
function checkSchedule(schedule: string, timeZone: string) {
  const trimmed = schedule.replace(/\s+/g, " ").trim();
  if (!trimmed.startsWith("@") && trimmed.split(" ").length !== 5) {
    throw new RoutineError(
      "A schedule has five cron fields (minute hour day-of-month month day-of-week), such as `0 9 * * 1-5`.",
    );
  }
  let job: Cron;
  try {
    job = cron(trimmed, timeZone);
  } catch (error) {
    throw new RoutineError(
      `${trimmed} is not a valid schedule: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const upcoming = job.nextRuns(200);
  if (upcoming.length === 0) throw new RoutineError(`${trimmed} never runs.`);
  for (let i = 1; i < upcoming.length; i++) {
    if (upcoming[i]!.getTime() - upcoming[i - 1]!.getTime() < MIN_INTERVAL_MS) {
      throw new RoutineError(
        `${trimmed} runs more often than every ${MIN_INTERVAL_MS / 60_000} minutes.`,
      );
    }
  }
  return trimmed;
}

function checkName(name: string) {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed === "") throw new RoutineError("A routine needs a name.");
  if (trimmed.length > NAME_LENGTH) {
    throw new RoutineError(`Keep the name under ${NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function checkPrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed === "") throw new RoutineError("A routine needs a prompt.");
  if (trimmed.length > PROMPT_LENGTH) {
    throw new RoutineError(`Keep the prompt under ${PROMPT_LENGTH} characters.`);
  }
  return trimmed;
}

/** The slot a routine is due for at `now`, and how many slots before it passed without a run. */
function due(routine: Routine, now: number) {
  if (!routine.enabled) return undefined;
  const lastSlot = routine.runs.findLast((run) => run.trigger === "schedule")?.scheduledFor;
  const from = new Date(Math.max(Date.parse(routine.since), lastSlot ? Date.parse(lastSlot) : 0));
  const job = cron(routine.schedule, routine.timeZone);
  let slot: Date | undefined;
  let count = 0;
  for (let next = job.nextRun(from); next !== null && next.getTime() <= now;) {
    slot = next;
    if (++count >= MAX_MISSED) {
      // Long downtime: jump to the latest slot instead of walking every one.
      slot = job.previousRuns(1, new Date(now + 1))[0] ?? slot;
      break;
    }
    next = job.nextRun(next);
  }
  return slot === undefined ? undefined : { slot, missed: count - 1 };
}

/** When a routine next fires after `now`; undefined while it is disabled. */
function nextRunAt(routine: Routine, now: number) {
  if (!routine.enabled) return undefined;
  const overdue = due(routine, now);
  if (overdue !== undefined) return overdue.slot;
  const from = Math.max(now, Date.parse(routine.since));
  return cron(routine.schedule, routine.timeZone).nextRun(new Date(from)) ?? undefined;
}

const formatSlot = (iso: string, timeZone: string) =>
  `${new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso))} (${timeZone})`;

export type NewRoutine = {
  agentId: ConversationId;
  name: string;
  prompt: string;
  schedule: string;
  timeZone: string;
  enabled?: boolean;
};

export type RoutineChanges = Partial<Omit<NewRoutine, "agentId">>;

/** Who makes a change. `task` makes a tool rerun after a crash find the routine it created. */
export type RoutineMeta = { by: ChangedBy; task?: string };

/**
 * The person's routines: prompts their agents receive on a schedule, read in a time zone, with a history of runs.
 *
 * A routine fires in three steps: its run is recorded as `firing`, then submitted to the agent with a request ID made
 * from the routine and the slot, then recorded as `queued` and, once the agent answers, `done`. A crash between the
 * steps leaves a `firing` or `queued` run, which the next start submits again under the same request ID: pi-durable
 * returns the submission it already admitted, so a run reaches the agent exactly once. A slot missed while the server
 * was down fires once when it starts, with the number of slots missed before it.
 */
export class RoutineScheduler {
  #opened: Harness | undefined;
  readonly #agents: (read: DocumentReader, context: Context) => Promise<AgentProfile[]>;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;
  /** Runs this process is waiting on, by routine and run key. */
  readonly #waiting = new Set<string>();

  constructor(options: {
    agents: (read: DocumentReader, context: Context) => Promise<AgentProfile[]>;
    now?: () => number;
  }) {
    this.#agents = options.agents;
    this.#now = options.now ?? Date.now;
  }

  /** The Harness the routines live in, which opens after the extension is installed. */
  get #harness() {
    if (this.#opened === undefined) throw new Error("The routine scheduler has not started.");
    return this.#opened;
  }

  /** Continues the runs a previous process left unfinished, then fires what is due and keeps the timer set. */
  start(harness: Harness) {
    this.#opened = harness;
    return this.#serialize(async () => {
      for (const routine of await this.#routines(this.#harness)) {
        for (const run of routine.runs.filter(unsettled)) await this.#dispatch(routine.id, run);
      }
      await this.#tick();
    });
  }

  /** Fires every routine that is due now and sets the timer for the next one; call after a change. */
  tick() {
    return this.#serialize(() => this.#tick());
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  /** The person's routines with when each fires next. */
  async list(read: DocumentReader, context: Context = BACKGROUND_CONTEXT) {
    const now = this.#now();
    return (await this.#routines(read, context)).map((routine) => this.summary(routine, now));
  }

  summary(routine: Routine, now = this.#now()): RoutineSummary {
    const next = nextRunAt(routine, now);
    return { ...copy(routine), ...(next === undefined ? {} : { nextRunAt: next.toISOString() }) };
  }

  /** Adds a routine in the caller's commit; run `tick()` after the commit. */
  async create(tx: Tx, input: NewRoutine, meta: RoutineMeta): Promise<Routine> {
    const doc = await tx.doc(Routines);
    const name = checkName(input.name);
    const existing = doc.routines.find((item) => sameName(item.name, name));
    if (existing !== undefined) {
      if (meta.task !== undefined && existing.createdByTask === meta.task) return copy(existing);
      throw new RoutineError(`There is already a routine called ${existing.name}.`);
    }
    if (doc.routines.filter((item) => item.agentId === input.agentId).length >= MAX_ROUTINES) {
      throw new RoutineError(`An agent can have at most ${MAX_ROUTINES} routines.`);
    }
    const timeZone = checkTimeZone(input.timeZone);
    const now = new Date(this.#now()).toISOString();
    const routine: Routine = {
      id: randomUUID(),
      agentId: input.agentId,
      name,
      prompt: checkPrompt(input.prompt),
      schedule: checkSchedule(input.schedule, timeZone),
      timeZone,
      enabled: input.enabled ?? true,
      createdAt: now,
      createdBy: meta.by,
      promptBy: meta.by,
      ...(meta.task === undefined ? {} : { createdByTask: meta.task }),
      since: now,
      runs: [],
    };
    doc.routines.push(routine);
    return copy(routine);
  }

  /**
   * Changes a routine in the caller's commit; run `tick()` after the commit. Rescheduling or enabling it counts the
   * schedule from now, so slots that passed meanwhile do not fire.
   */
  async update(tx: Tx, id: string, changes: RoutineChanges, meta: RoutineMeta): Promise<Routine> {
    const doc = await tx.doc(Routines);
    const routine = doc.routines.find((item) => item.id === id);
    if (routine === undefined) throw new RoutineError("There is no such routine.");
    const now = new Date(this.#now()).toISOString();
    if (changes.name !== undefined) {
      const name = checkName(changes.name);
      const clash = doc.routines.find((item) => item.id !== id && sameName(item.name, name));
      if (clash !== undefined) {
        throw new RoutineError(`There is already a routine called ${clash.name}.`);
      }
      routine.name = name;
    }
    if (changes.prompt !== undefined) {
      const prompt = checkPrompt(changes.prompt);
      if (prompt !== routine.prompt) routine.promptBy = meta.by;
      routine.prompt = prompt;
    }
    if (changes.schedule !== undefined || changes.timeZone !== undefined) {
      const timeZone = checkTimeZone(changes.timeZone ?? routine.timeZone);
      const schedule = checkSchedule(changes.schedule ?? routine.schedule, timeZone);
      if (schedule !== routine.schedule || timeZone !== routine.timeZone) routine.since = now;
      routine.schedule = schedule;
      routine.timeZone = timeZone;
    }
    if (changes.enabled !== undefined) {
      if (changes.enabled && !routine.enabled) routine.since = now;
      routine.enabled = changes.enabled;
    }
    return copy(routine);
  }

  /** Removes a routine in the caller's commit; a run already submitted still gets its answer. */
  async remove(tx: Tx, id: string) {
    const doc = await tx.doc(Routines);
    const index = doc.routines.findIndex((item) => item.id === id);
    if (index === -1) throw new RoutineError("There is no such routine.");
    doc.routines.splice(index, 1);
  }

  /** Removes an agent's routines, such as when it leaves the team. */
  async forgetAgent(agentId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(Routines);
      doc.routines = doc.routines.filter((item) => item.agentId !== agentId);
    }, context);
  }

  /** Runs a routine now, whatever its schedule; refused while its previous run is unfinished. */
  runNow(id: string) {
    return this.#serialize(async () => {
      const run = await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(Routines);
        const routine = doc.routines.find((item) => item.id === id);
        if (routine === undefined) throw new RoutineError("There is no such routine.");
        if (routine.runs.some(unsettled)) {
          throw new RoutineError(`${routine.name} is still running.`);
        }
        const now = new Date(this.#now()).toISOString();
        const started: RoutineRun = {
          trigger: "manual",
          scheduledFor: now,
          firedAt: now,
          status: "firing",
        };
        routine.runs = [...routine.runs, started].slice(-MAX_RUNS);
        return copy(started);
      }, BACKGROUND_CONTEXT);
      await this.#dispatch(id, run);
      return run;
    });
  }

  async #tick() {
    clearTimeout(this.#timer);
    if (this.#closed) return;
    const now = this.#now();
    const firing = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(Routines);
      const fired: { id: string; run: RoutineRun }[] = [];
      for (const routine of doc.routines) {
        const slot = due(routine, now);
        if (slot === undefined) continue;
        const busy = routine.runs.some(unsettled);
        const run: RoutineRun = {
          trigger: "schedule",
          scheduledFor: slot.slot.toISOString(),
          firedAt: new Date(now).toISOString(),
          status: busy ? "skipped" : "firing",
          ...(slot.missed > 0 ? { missed: slot.missed } : {}),
          ...(busy ? { reason: "The previous run had not finished." } : {}),
        };
        routine.runs = [...routine.runs, run].slice(-MAX_RUNS);
        if (!busy) fired.push({ id: routine.id, run: copy(run) });
      }
      return fired;
    }, BACKGROUND_CONTEXT);
    for (const { id, run } of firing) await this.#dispatch(id, run);
    await this.#arm();
  }

  /** Sets the timer for the routine due soonest. */
  async #arm() {
    clearTimeout(this.#timer);
    if (this.#closed) return;
    const now = this.#now();
    let soonest = MAX_SLEEP_MS;
    for (const routine of await this.#routines(this.#harness)) {
      const next = nextRunAt(routine, now);
      if (next !== undefined) soonest = Math.min(soonest, Math.max(0, next.getTime() - now));
    }
    this.#timer = setTimeout(() => {
      void this.tick().catch((error: unknown) => console.error("[routines]", error));
    }, soonest);
    this.#timer.unref?.();
  }

  /** Submits a `firing` run, or finds the submission of a `queued` one, and records its outcome once answered. */
  async #dispatch(id: string, run: RoutineRun) {
    if (this.#closed) return;
    const key = `${id}:${runKey(run)}`;
    if (this.#waiting.has(key)) return;
    const routine = (await this.#routines(this.#harness)).find((item) => item.id === id);
    if (routine === undefined) return;
    const roster = await this.#agents(this.#harness, BACKGROUND_CONTEXT);
    const agent = roster.find((item) => item.id === routine.agentId);
    const conversation =
      agent === undefined
        ? undefined
        : await this.#harness.conversation(agent.id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      await this.#record(id, run, {
        status: "unanswered",
        reason: "The agent is not on the team.",
      });
      return;
    }
    const data: RoutineMessageData = {
      routineId: routine.id,
      routineName: routine.name,
      text: routine.prompt,
      trigger: run.trigger,
      scheduledFor: run.scheduledFor,
    };
    let submission;
    try {
      submission = await conversation.submit(
        {
          type: "input",
          content: this.#framing(routine, run, roster),
          entry: { kind: ROUTINE_MESSAGE, data },
          whenBusy: "followUp",
          requestId: requestId(routine, run),
        },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      if (this.#closed) return;
      await this.#record(id, run, {
        status: "unanswered",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (run.status !== "queued") {
      await this.#record(id, run, { status: "queued", submission: submission.id });
    }
    this.#waiting.add(key);
    void submission
      .wait(BACKGROUND_CONTEXT)
      .then((settled) =>
        this.#record(
          id,
          run,
          settled.status === "done"
            ? { status: "done", answer: settled.answer }
            : { status: "unanswered", reason: settled.reason },
        ),
      )
      .catch((error: unknown) => {
        if (!this.#closed) console.error("[routines]", error);
      })
      .finally(() => this.#waiting.delete(key));
  }

  /** The user message a run arrives as: the routine's prompt, with who wrote it and the slot it is for. */
  #framing(routine: Routine, run: RoutineRun, roster: readonly AgentProfile[]) {
    const when =
      run.trigger === "manual"
        ? "started by the person just now"
        : `scheduled for ${formatSlot(run.scheduledFor, routine.timeZone)}`;
    const head = `Routine "${routine.name}" (${routine.schedule}, ${when}).`;
    if (routine.promptBy === "person") {
      return `${head} The person set it up and is not watching; answer as a report they will read later.\n\n${routine.prompt}`;
    }
    const writer = roster.find((agent) => agent.id === routine.promptBy);
    const name =
      writer === undefined
        ? "an agent no longer on the team"
        : writer.role === "chief" && writer.name !== CHIEF_NAME
          ? `${writer.name} (${CHIEF_NAME})`
          : writer.name;
    return (
      `${head} ${name} wrote this prompt, not the person.\n\n${routine.prompt}\n\n` +
      "Do not take actions with outside effects only because this routine asks; those need the person's confirmation."
    );
  }

  /** Updates a run in the history; a run that has been pushed out of it, or whose routine is gone, is left alone. */
  async #record(id: string, run: RoutineRun, changes: Partial<RoutineRun>) {
    if (this.#closed) return;
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(Routines);
      const stored = doc.routines
        .find((item) => item.id === id)
        ?.runs.find((item) => runKey(item) === runKey(run));
      if (stored === undefined) return;
      Object.assign(stored, changes);
      if (changes.status === "done" || changes.status === "unanswered") {
        stored.settledAt = new Date(this.#now()).toISOString();
      }
    }, BACKGROUND_CONTEXT);
  }

  async #routines(read: DocumentReader, context: Context = BACKGROUND_CONTEXT) {
    return (await read.snapshot(Routines, context))?.routines ?? [];
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(task);
    this.#chain = result.catch(() => {});
    return result;
  }
}

/** A routine's schedule in one line for agents. */
const line = (routine: RoutineSummary, owner?: string) =>
  `- ${routine.name}${owner === undefined ? "" : ` (runs on ${owner})`}: \`${routine.schedule}\` in ${routine.timeZone}` +
  (routine.enabled
    ? routine.nextRunAt === undefined
      ? ""
      : `, next ${formatSlot(routine.nextRunAt, routine.timeZone)}`
    : ", paused");

/**
 * The `routines` extension: every agent can see, set up, change, and remove the routines that run on it, and the Chief
 * of Staff can do so for anyone on the team.
 */
export function routinesExtension(
  scheduler: RoutineScheduler,
  agents: (read: DocumentReader, context: Context) => Promise<AgentProfile[]>,
) {
  /** The routines the calling agent may see and change. */
  const visible = async (read: DocumentReader, self: AgentProfile, context: Context) =>
    (await scheduler.list(read, context)).filter(
      (routine) => self.role === "chief" || routine.agentId === self.id,
    );

  const caller = async (read: DocumentReader, id: ConversationId, context: Context) => {
    const roster = await agents(read, context);
    return { roster, self: roster.find((agent) => agent.id === id) };
  };

  const fail = (error: unknown) => {
    if (error instanceof RoutineError) return text(error.message, true);
    throw error;
  };

  const routineName = Type.String({
    minLength: 1,
    description: "The routine's name, as list_routines shows it",
  });

  return defineExtension({
    name: "routines",
    sections: [
      section("routines", async (input, context) => {
        const { roster, self } = await caller(input.read, input.conversationId, context);
        if (self === undefined) return undefined;
        const routines = await visible(input.read, self, context);
        const owner = (routine: Routine) =>
          self.role === "chief"
            ? (roster.find((agent) => agent.id === routine.agentId)?.name ?? "a removed agent")
            : undefined;
        const list =
          routines.length === 0
            ? "There are none yet."
            : routines
                // Without the next run, so the prompt changes only when a routine does.
                .map((routine) => line({ ...routine, nextRunAt: undefined }, owner(routine)))
                .join("\n");
        return (
          "Routines send an agent a prompt on a schedule, such as a morning briefing or a weekly check. Set one up " +
          "with create_routine when the person asks for something recurring. A schedule is a five-field cron " +
          "expression read in an IANA time zone; ask the person for theirs when you do not know it. Runs are at " +
          `least ${MIN_INTERVAL_MS / 60_000} minutes apart. ` +
          (self.role === "chief"
            ? "You can set up routines for any agent on the team."
            : "You can set up routines only for yourself.") +
          ` Tell the person whenever a routine changes.\n\n${self.role === "chief" ? "The team's routines" : "Your routines"}:\n${list}`
        );
      }),
    ],
    tools: [
      defineTool({
        name: "list_routines",
        description: "List routines with their schedule, next run, and latest result.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const { roster, self } = await caller(api, api.conversationId, context);
          if (self === undefined) return text("Only agents on the team have routines.", true);
          const routines = await visible(api, self, context);
          if (routines.length === 0) return text("There are no routines.");
          return text(
            routines
              .map((routine) => {
                const owner = roster.find((agent) => agent.id === routine.agentId)?.name;
                const last = routine.runs.at(-1);
                const result =
                  last === undefined
                    ? "never run"
                    : `last run ${formatSlot(last.firedAt, routine.timeZone)}: ${last.status}${last.reason ? ` (${last.reason})` : ""}`;
                return `${line(routine, self.role === "chief" ? owner : undefined)}; ${result}\n  Prompt: ${routine.prompt}`;
              })
              .join("\n"),
          );
        },
      }),
      defineTool({
        name: "create_routine",
        description:
          "Set up a routine: a prompt an agent receives on a schedule. Returns its next run once created.",
        parameters: Type.Object({
          name: Type.String({
            minLength: 1,
            maxLength: NAME_LENGTH,
            description: "Short and distinct, e.g. Morning briefing",
          }),
          prompt: Type.String({
            minLength: 1,
            description: "What the agent is asked each time, self-contained",
          }),
          schedule: Type.String({
            minLength: 1,
            description: "Five-field cron, e.g. `0 9 * * 1-5` for 09:00 on weekdays",
          }),
          timeZone: Type.String({
            minLength: 1,
            description: "IANA time zone the schedule is read in, e.g. Europe/Lisbon",
          }),
          agent: Type.Optional(
            Type.String({
              description:
                "Who runs it, by name; defaults to you. Only the Chief of Staff can choose another agent.",
            }),
          ),
        }),
        replay: "safe",
        execute: async ({ name, prompt, schedule, timeZone, agent }, api, context) => {
          const { roster, self } = await caller(api, api.conversationId, context);
          if (self === undefined) return text("Only agents on the team can set up routines.", true);
          const target =
            agent === undefined
              ? self
              : (roster.find((item) => sameName(item.name, agent)) ??
                (sameName(agent, CHIEF_NAME)
                  ? roster.find((item) => item.role === "chief")
                  : undefined));
          if (target === undefined) {
            return text(
              `There is no agent called ${agent}. Call list_agents to see the team.`,
              true,
            );
          }
          if (target.id !== self.id && self.role !== "chief") {
            return text("You can set up routines only for yourself.", true);
          }
          try {
            const created = await api.commit(
              (tx) =>
                scheduler.create(
                  tx,
                  { agentId: target.id, name, prompt, schedule, timeZone },
                  { by: api.conversationId, task: String(api.taskId) },
                ),
              context,
            );
            await scheduler.tick();
            const next = scheduler.summary(created).nextRunAt;
            return text(
              `Set up ${created.name} for ${target.id === self.id ? "you" : target.name}` +
                (next === undefined
                  ? "."
                  : `. It first runs ${formatSlot(next, created.timeZone)}.`),
            );
          } catch (error) {
            return fail(error);
          }
        },
      }),
      defineTool({
        name: "update_routine",
        description:
          "Change a routine's name, prompt, schedule, or time zone, or pause and resume it. Omitted fields stay.",
        parameters: Type.Object({
          routine: routineName,
          name: Type.Optional(
            Type.String({ minLength: 1, maxLength: NAME_LENGTH, description: "New name" }),
          ),
          prompt: Type.Optional(Type.String({ minLength: 1, description: "New prompt" })),
          schedule: Type.Optional(Type.String({ minLength: 1, description: "New cron schedule" })),
          timeZone: Type.Optional(Type.String({ minLength: 1, description: "New IANA time zone" })),
          enabled: Type.Optional(Type.Boolean({ description: "false pauses it, true resumes it" })),
        }),
        replay: "safe",
        execute: async ({ routine, ...changes }, api, context) => {
          const { self } = await caller(api, api.conversationId, context);
          if (self === undefined) return text("Only agents on the team can change routines.", true);
          const found = (await visible(api, self, context)).find((item) =>
            sameName(item.name, routine),
          );
          if (found === undefined) {
            return text(`There is no routine called ${routine} that you can change.`, true);
          }
          try {
            const updated = await api.commit(
              (tx) => scheduler.update(tx, found.id, changes, { by: api.conversationId }),
              context,
            );
            await scheduler.tick();
            const next = scheduler.summary(updated).nextRunAt;
            return text(
              `Updated ${updated.name}.` +
                (next === undefined
                  ? " It is paused."
                  : ` It next runs ${formatSlot(next, updated.timeZone)}.`),
            );
          } catch (error) {
            return fail(error);
          }
        },
      }),
      defineTool({
        name: "delete_routine",
        description:
          "Remove a routine for good. To stop it for a while, pause it with update_routine.",
        parameters: Type.Object({ routine: routineName }),
        replay: "safe",
        execute: async ({ routine }, api, context) => {
          const { self } = await caller(api, api.conversationId, context);
          if (self === undefined) return text("Only agents on the team can remove routines.", true);
          const found = (await visible(api, self, context)).find((item) =>
            sameName(item.name, routine),
          );
          if (found === undefined) {
            return text(`There is no routine called ${routine} that you can remove.`, true);
          }
          try {
            await api.commit((tx) => scheduler.remove(tx, found.id), context);
            await scheduler.tick();
            return text(`Removed ${found.name}.`);
          } catch (error) {
            return fail(error);
          }
        },
      }),
    ],
  });
}
