import type { SystemMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";

export type PromptSection = { name: string; text: string };

export type PromptTool = { name: string; description: string };

/** The system prompt in effect for a conversation's next request, as the model receives it. */
export type SystemPrompt = {
  /** Named sections in prompt order; the base content, if any, comes first as `content`. */
  sections: PromptSection[];
  tools: PromptTool[];
  /** The complete prompt text: the sections joined as pi-ai's `getSystemMessageText` does. */
  text: string;
};

const textOf = (content: SystemMessage["content"]) =>
  typeof content === "string" ? content : content.map((block) => block.text).join("\n");

/**
 * Replays the view's `pi.system` entries, mirroring pi-ai's `getCurrentSystemMessage`: content accumulates, sections
 * are patched by name (`null` removes one, re-adding appends), and tools are added and removed by name.
 */
export function toSystemPrompt(view: ConversationView | undefined): SystemPrompt | undefined {
  if (view === undefined) return undefined;
  const content: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, PromptTool>();
  let found = false;

  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "system") continue;
      found = true;
      const text = textOf(message.content);
      if (text.length > 0) content.push(text);
      for (const [name, value] of Object.entries(message.sections ?? {})) {
        if (value === null) sections.delete(name);
        else sections.set(name, value);
      }
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) {
        tools.set(tool.name, { name: tool.name, description: tool.description });
      }
    }
  }
  if (!found) return undefined;

  const parts: PromptSection[] = [
    ...(content.length > 0 ? [{ name: "content", text: content.join("\n\n") }] : []),
    ...[...sections].map(([name, text]) => ({ name, text })),
  ].filter((part) => part.text.length > 0);
  return {
    sections: parts,
    tools: [...tools.values()],
    text: parts.map((part) => part.text).join("\n\n"),
  };
}
