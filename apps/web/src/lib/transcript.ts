import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ConversationView, LiveState, ToolSlot } from "@earendil-works/pi-durable";

/** One step the agent takes inside a turn, rendered as a Trace row. */
export type Step =
  | { kind: "thinking"; id: string; text: string; running: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      status: "pending" | "running" | "done" | "error";
      output?: string;
    };

export type AssistantPart = { type: "steps"; steps: Step[] } | { type: "text"; text: string };

export type Turn =
  | {
      role: "user";
      id: string;
      text: string;
      /** The teammate that sent it; absent for the person's own messages. */
      /** A teammate, a connector for messages from outside, or a routine. */
      from?: { id?: number; name: string };
    }
  | {
      role: "assistant";
      id: string;
      parts: AssistantPart[];
      /** The turn still receives the live generation. */
      streaming: boolean;
      error?: string;
    };

export type Transcript = {
  turns: Turn[];
  /** A run is in progress: the agent is generating or running tools. */
  busy: boolean;
  retry?: { at: number; error: string };
};

const textOf = (content: UserMessage["content"] | ToolResultMessage["content"]) =>
  typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

/** Mirrors `AGENT_MESSAGE` in apps/server/src/team.ts: a message from a teammate. */
const AGENT_MESSAGE = "pibot.agent-message";

/** Mirrors `INBOUND_MESSAGE` in apps/server/src/connectors.ts: a message posted to an inbound connector. */
const INBOUND_MESSAGE = "pibot.inbound-message";

/** Mirrors `ROUTINE_MESSAGE` in apps/server/src/team.ts: a routine's prompt, sent on its schedule. */
const ROUTINE_MESSAGE = "pibot.routine-message";

const first = (entry: { model?: readonly Message[] }) => entry.model?.[0];

/** Folds the server's conversation view into chat turns. */
export function toTranscript(view: ConversationView | undefined): Transcript {
  if (view === undefined) return { turns: [], busy: false };
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const busy = live.run !== undefined;

  const results = new Map<string, ToolResultMessage>();
  for (const entry of view.entries) {
    const message = first(entry);
    if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      results.set(message.toolCallId, message as ToolResultMessage);
    }
  }
  const slots = new Map<string, ToolSlot>((live.tools ?? []).map((slot) => [slot.callId, slot]));

  const turns: Turn[] = [];
  const assistantTurn = (id: string) => {
    const last = turns.at(-1);
    if (last?.role === "assistant") return last;
    const turn: Turn = { role: "assistant", id, parts: [], streaming: false };
    turns.push(turn);
    return turn;
  };

  const addMessage = (id: string, message: AssistantMessage, partial: boolean) => {
    const turn = assistantTurn(id);
    if (partial) turn.streaming = true;
    message.content.forEach((block, index) => {
      if (block.type === "text") {
        if (block.text.length > 0) turn.parts.push({ type: "text", text: block.text });
        return;
      }
      let group = turn.parts.at(-1);
      if (group?.type !== "steps") {
        group = { type: "steps", steps: [] };
        turn.parts.push(group);
      }
      if (block.type === "thinking") {
        if (block.redacted || block.thinking.length === 0) return;
        group.steps.push({
          kind: "thinking",
          id: `${id}:${index}`,
          text: block.thinking,
          running: partial && index === message.content.length - 1,
        });
        return;
      }
      const result = results.get(block.id);
      const slot = slots.get(block.id);
      group.steps.push({
        kind: "tool",
        id: block.id,
        name: block.name,
        args: block.arguments,
        status: result
          ? result.isError
            ? "error"
            : "done"
          : busy
            ? slot?.status === "running" || partial
              ? "running"
              : "pending"
            : "error",
        output: result ? textOf(result.content) : slot?.output,
      });
    });
    if (message.stopReason === "error" && message.errorMessage) turn.error = message.errorMessage;
  };

  for (const entry of view.entries) {
    const message = first(entry);
    if (entry.kind === "pi.user" && message?.role === "user") {
      turns.push({ role: "user", id: String(entry.id), text: textOf(message.content) });
    } else if (entry.kind === AGENT_MESSAGE) {
      const { from, fromName, text } = entry.data as {
        from: number;
        fromName: string;
        text: string;
      };
      turns.push({ role: "user", id: String(entry.id), text, from: { id: from, name: fromName } });
    } else if (entry.kind === INBOUND_MESSAGE) {
      const { connectorName, text } = entry.data as { connectorName: string; text: string };
      turns.push({ role: "user", id: String(entry.id), text, from: { name: connectorName } });
    } else if (entry.kind === ROUTINE_MESSAGE) {
      const { routineName, text } = entry.data as { routineName: string; text: string };
      turns.push({
        role: "user",
        id: String(entry.id),
        text,
        from: { name: `routine ${routineName}` },
      });
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      addMessage(String(entry.id), message, false);
    }
  }

  const partial = live.generation?.message as AssistantMessage | undefined;
  if (partial !== undefined) addMessage("live", partial, true);
  // Busy with nothing streamed yet: show an empty reply that is working.
  if (busy && turns.at(-1)?.role !== "assistant") assistantTurn("live").streaming = true;
  const last = turns.at(-1);
  if (busy && last?.role === "assistant") last.streaming = true;

  return { turns, busy, ...(live.generation?.retry ? { retry: live.generation.retry } : {}) };
}
