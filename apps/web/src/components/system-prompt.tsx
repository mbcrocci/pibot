import { ChevronRightIcon, ScrollTextIcon } from "lucide-react";

import { CopyAction } from "@/components/chat";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { SystemPrompt as Prompt } from "@/lib/system-prompt";

/** Header button that opens the agent's current system prompt, section by section, and its tools. */
export function SystemPrompt({ prompt }: { prompt: Prompt | undefined }) {
  if (prompt === undefined) return null;

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <ScrollTextIcon />
        System prompt
      </SheetTrigger>
      <SheetContent className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <div className="flex items-center gap-1">
            <SheetTitle>System prompt</SheetTitle>
            <CopyAction value={prompt.text} />
          </div>
          <SheetDescription>
            What this agent's model receives, as of its latest request:{" "}
            {prompt.text.length.toLocaleString()} characters in {prompt.sections.length} sections,
            and {prompt.tools.length} tools.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-y-auto px-4 pb-4">
          {prompt.sections.map((section) => (
            <Collapsible key={section.name} className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 p-3 text-left">
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                <span className="font-mono font-medium">{section.name}</span>
                <span className="ml-auto text-muted-foreground">
                  {section.text.length.toLocaleString()} chars
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t">
                <pre className="overflow-x-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap">
                  {section.text}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
          {prompt.tools.length > 0 && (
            <Collapsible className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 p-3 text-left">
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                <span className="font-medium">Tools</span>
                <span className="ml-auto text-muted-foreground">{prompt.tools.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 border-t px-4 py-3">
                {prompt.tools.map((tool) => (
                  <div key={tool.name} className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs font-medium">{tool.name}</span>
                    <span className="text-xs whitespace-pre-wrap text-muted-foreground">
                      {tool.description}
                    </span>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
