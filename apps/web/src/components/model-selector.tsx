import { ChevronDownIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroupButton } from "@/components/ui/input-group";
import type { CatalogModel, ModelChoice, ThinkingLevel } from "@/lib/api";

const levelNames: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const keyOf = (model: { provider: string; modelId: string }) =>
  `${model.provider}/${model.modelId}`;

/** Keeps the thinking level when the new model supports it, else medium, else its lowest level. */
function levelFor(model: CatalogModel, current: ThinkingLevel): ThinkingLevel {
  if (model.thinkingLevels.includes(current)) return current;
  if (model.thinkingLevels.includes("medium")) return "medium";
  return model.thinkingLevels[0] ?? "off";
}

/** Two menus: one picks the model the agent runs, the other how hard it thinks. */
export function ModelSelector({
  models,
  value,
  onChange,
}: {
  models: readonly CatalogModel[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
}) {
  const current = models.find((model) => keyOf(model) === keyOf(value.model));
  // An agent may run a model outside the menu.
  const levels = current?.thinkingLevels ?? [value.thinkingLevel];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <InputGroupButton
              size="sm"
              variant="outline"
              aria-label={`Model: ${current?.name ?? value.model.modelId}`}
            />
          }
        >
          {current?.name ?? value.model.modelId}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuRadioGroup
            value={keyOf(value.model)}
            onValueChange={(key) => {
              const model = models.find((item) => keyOf(item) === key);
              if (model === undefined) return;
              onChange({
                model: { provider: model.provider, modelId: model.modelId },
                thinkingLevel: levelFor(model, value.thinkingLevel),
              });
            }}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>OpenAI</DropdownMenuLabel>
              {models.map((model) => (
                <DropdownMenuRadioItem
                  key={keyOf(model)}
                  value={keyOf(model)}
                  disabled={!model.available}
                  closeOnClick
                >
                  {model.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuRadioGroup>
          {models.some((model) => !model.available) && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Sign in with ChatGPT to use these models.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <InputGroupButton
              size="sm"
              variant="outline"
              aria-label={`Thinking: ${levelNames[value.thinkingLevel]}`}
              disabled={levels.length < 2}
            />
          }
        >
          <span className="text-muted-foreground">Thinking</span>
          {levelNames[value.thinkingLevel]}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Thinking</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={value.thinkingLevel}
              onValueChange={(level) =>
                onChange({ model: value.model, thinkingLevel: level as ThinkingLevel })
              }
            >
              {levels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level} closeOnClick>
                  {levelNames[level]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
