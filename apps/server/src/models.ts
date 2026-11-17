import type { Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

/** Models the person can pick in the web app, in menu order. */
export const SELECTABLE_MODELS: readonly ModelRef[] = [
  { provider: "openai", modelId: "gpt-6.1-sol" },
  { provider: "openai", modelId: "gpt-6-luna" },
  { provider: "openai", modelId: "gpt-6-astra" },
];

const LEVEL_ORDER: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ModelChoice = { model: ModelRef; thinkingLevel: ModelThinkingLevel };

export type CatalogEntry = ModelRef & {
  name: string;
  thinkingLevels: ModelThinkingLevel[];
  /** Whether the provider has credentials, so a request can succeed. */
  available: boolean;
};

/** Thinking levels a model accepts: a `null` in its level map marks a level it does not support. */
export function thinkingLevels(model: Model<string> | undefined): ModelThinkingLevel[] {
  if (model === undefined || !model.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  return LEVEL_ORDER.filter((level) => map?.[level] !== null);
}

/** Medium when the model supports it, so a fresh conversation thinks some but not much. */
export function defaultThinkingLevel(levels: readonly ModelThinkingLevel[]): ModelThinkingLevel {
  return levels.includes("medium") ? "medium" : (levels[0] ?? "off");
}

export function choiceFor(models: Models, model: ModelRef): ModelChoice {
  return {
    model,
    thinkingLevel: defaultThinkingLevel(
      thinkingLevels(models.getModel(model.provider, model.modelId)),
    ),
  };
}

export async function catalog(models: Models): Promise<CatalogEntry[]> {
  const configured = new Map<string, boolean>();
  for (const { provider } of SELECTABLE_MODELS) {
    if (!configured.has(provider)) {
      configured.set(
        provider,
        (await models.checkAuth(provider).catch(() => undefined)) !== undefined,
      );
    }
  }
  return SELECTABLE_MODELS.flatMap((ref) => {
    const model = models.getModel(ref.provider, ref.modelId);
    if (model === undefined) return [];
    return [
      {
        ...ref,
        name: model.name,
        thinkingLevels: thinkingLevels(model),
        available: configured.get(ref.provider) ?? false,
      },
    ];
  });
}

/**
 * Checks a requested model and thinking level against the selectable models. `current` fills a
 * missing model; a missing thinking level falls back to the model's default.
 */
export function validateChoice(
  models: Models,
  request: { model?: unknown; thinkingLevel?: unknown },
  current?: ModelRef,
  selectable: readonly ModelRef[] = SELECTABLE_MODELS,
): ModelChoice | string {
  const requested = request.model as Partial<ModelRef> | undefined;
  const ref =
    requested === undefined
      ? current
      : selectable.find(
          (item) => item.provider === requested?.provider && item.modelId === requested?.modelId,
        );
  if (ref === undefined) return "Unknown model";
  const levels = thinkingLevels(models.getModel(ref.provider, ref.modelId));
  if (request.thinkingLevel === undefined) {
    return { model: ref, thinkingLevel: defaultThinkingLevel(levels) };
  }
  if (!levels.includes(request.thinkingLevel as ModelThinkingLevel)) {
    return `${ref.modelId} does not support thinking level ${JSON.stringify(request.thinkingLevel)}`;
  }
  return { model: ref, thinkingLevel: request.thinkingLevel as ModelThinkingLevel };
}
