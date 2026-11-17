import * as React from "react";
import {
  AlertCircleIcon,
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  SquareIcon,
  WrenchIcon,
} from "lucide-react";

import { Markdown } from "@/components/markdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type { Step, Transcript, Turn } from "@/lib/transcript";

export function Chat({
  transcript,
  pending,
  connected,
  title,
  icon,
  empty,
  suggestions = [],
  placeholder,
  onSend,
  onStop,
  actions,
  composerActions,
}: {
  transcript: Transcript;
  /** A message sent but not yet in the transcript. */
  pending?: string;
  /** Whether the live view is connected; absent before a conversation exists. */
  connected?: boolean;
  /** The agent's name. */
  title?: string;
  /** Shown beside the title and in the empty state. */
  icon: React.ReactNode;
  /** What the empty state says before the first message. */
  empty: { title: string; description: string };
  /** One-click first messages. */
  suggestions?: readonly string[];
  placeholder: string;
  onSend: (text: string) => void;
  /** Stops the run in progress. */
  onStop?: () => void;
  /** Extra header controls, such as the account menu. */
  actions?: React.ReactNode;
  /** Controls beside the send button, such as the model selector. */
  composerActions?: React.ReactNode;
}) {
  const [text, setText] = React.useState("");
  const formRef = React.useRef<HTMLFormElement>(null);
  const busy = transcript.busy || pending !== undefined;
  const canSend = text.trim().length > 0 && !busy;
  const turns: Turn[] =
    pending === undefined
      ? transcript.turns
      : [
          ...transcript.turns,
          { role: "user", id: "pending", text: pending },
          { role: "assistant", id: "pending-reply", parts: [], streaming: true },
        ];

  function send(value: string) {
    if (value.trim().length === 0 || busy) return;
    onSend(value.trim());
    setText("");
  }

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex h-dvh w-full min-w-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger />
            <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
            <span className="truncate font-medium">{title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {connected === false && (
              <span className="self-end text-xs text-muted-foreground">Reconnecting…</span>
            )}
            {actions}
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {turns.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">{icon}</EmptyMedia>
                <EmptyTitle>{empty.title}</EmptyTitle>
                <EmptyDescription>{empty.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent
                  aria-busy={busy}
                  className="mx-auto w-full max-w-3xl gap-6 px-6 py-6"
                >
                  {turns.map((turn) =>
                    turn.role === "user" ? (
                      <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            {turn.from !== undefined && (
                              <span className="self-end text-xs text-muted-foreground">
                                From {turn.from.name}
                              </span>
                            )}
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">
                                {turn.text}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={turn.id} messageId={turn.id}>
                        <AssistantMessage turn={turn} />
                      </MessageScrollerItem>
                    ),
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          )}
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pb-6">
          {transcript.retry && (
            <p className="text-xs text-muted-foreground">
              Retrying after an error: {transcript.retry.error}
            </p>
          )}
          {turns.length === 0 && (
            <div className="flex scroll-fade-x gap-2 overflow-x-auto overscroll-x-contain no-scrollbar">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => send(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          )}
          <form
            ref={formRef}
            onSubmit={(event) => {
              event.preventDefault();
              send(text);
            }}
          >
            <InputGroup>
              <InputGroupTextarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={placeholder}
                aria-label="Message"
                className="min-h-14"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
              />
              <InputGroupAddon align="block-end" className="pt-1">
                {composerActions}
                {transcript.busy && pending === undefined && onStop ? (
                  <InputGroupButton
                    type="button"
                    variant="default"
                    size="icon-sm"
                    className="ml-auto"
                    onClick={onStop}
                  >
                    <SquareIcon className="fill-current" />
                    <span className="sr-only">Stop</span>
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="icon-sm"
                    disabled={!canSend}
                    className="ml-auto"
                  >
                    {busy ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
                    <span className="sr-only">Send</span>
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </MessageScrollerProvider>
  );
}

function AssistantMessage({ turn }: { turn: Extract<Turn, { role: "assistant" }> }) {
  const reply = turn.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const lastPart = turn.parts.at(-1);

  return (
    <Message>
      <MessageContent className="gap-3">
        {turn.parts.map((part, index) =>
          part.type === "steps" ? (
            <Trace key={index}>
              {part.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </Trace>
          ) : (
            <Markdown key={index} streaming={turn.streaming && part === lastPart}>
              {part.text}
            </Markdown>
          ),
        )}
        {turn.streaming && lastPart?.type !== "text" && !hasRunningStep(turn) && (
          <TraceLine status="running">
            <TraceIcon>
              <LoaderCircleIcon className="animate-spin" />
            </TraceIcon>
            <TraceTitle>Working</TraceTitle>
          </TraceLine>
        )}
        {turn.error && (
          <Trace>
            <TraceCollapsible defaultOpen>
              <TraceCollapsibleTrigger>
                <TraceLine status="error">
                  <TraceIcon>
                    <AlertCircleIcon />
                  </TraceIcon>
                  <TraceTitle>Failed to finish the reply</TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="whitespace-pre-wrap">
                {turn.error}
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        )}
        {!turn.streaming && reply && (
          <MessageFooter className="px-0">
            <CopyAction value={reply} />
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

const hasRunningStep = (turn: Extract<Turn, { role: "assistant" }>) =>
  turn.parts.some(
    (part) =>
      part.type === "steps" &&
      part.steps.some((step) =>
        step.kind === "thinking" ? step.running : step.status === "running",
      ),
  );

function StepRow({ step }: { step: Step }) {
  return step.kind === "thinking" ? <ReasoningRow step={step} /> : <ToolRow step={step} />;
}

function ReasoningRow({ step }: { step: Extract<Step, { kind: "thinking" }> }) {
  const [open, setOpen] = React.useState<boolean>();
  const line = (
    <TraceLine status={step.running ? "running" : undefined}>
      <TraceIcon>
        {step.running ? <LoaderCircleIcon className="animate-spin" /> : <BrainIcon />}
      </TraceIcon>
      <TraceTitle>{step.running ? "Thinking" : "Thought"}</TraceTitle>
    </TraceLine>
  );

  // A plain line until the first text arrives, so there is nothing empty to expand.
  if (step.text.trim().length === 0) return line;

  return (
    <TraceCollapsible open={open ?? step.running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{step.text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

const toolVerb: Record<Extract<Step, { kind: "tool" }>["status"], string> = {
  pending: "Waiting to call",
  running: "Calling",
  done: "Called",
  error: "Failed to call",
};

const servers: Record<string, string> = { meta_ads: "Meta Ads" };

/** `mcp__meta_ads__get_insights` reads as `get_insights · Meta Ads`. */
function toolLabel(name: string) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (match === null) return name;
  const [, server = "", tool = ""] = match;
  return `${tool} · ${servers[server] ?? server}`;
}

function ToolRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const status =
    step.status === "error" ? "error" : step.status === "done" ? undefined : step.status;
  const details = [
    `// input\n${JSON.stringify(step.args, null, 2)}`,
    ...(step.output ? [`// output\n${step.output}`] : []),
  ].join("\n\n");

  return (
    <TraceCollapsible defaultOpen={step.status === "error"}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>
            {step.status === "running" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <WrenchIcon />
            )}
          </TraceIcon>
          <TraceTitle>
            {toolVerb[step.status]} {toolLabel(step.name)}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap className="max-h-64">
            {details}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export function CopyAction({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  const label = copied ? "Copied" : "Copy";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => {
              void navigator.clipboard.writeText(value);
              setCopied(true);
            }}
          />
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
