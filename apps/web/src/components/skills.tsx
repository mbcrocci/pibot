import * as React from "react";
import {
  BookOpenIcon,
  ChevronRightIcon,
  FileArchiveIcon,
  FileTextIcon,
  FolderUpIcon,
  Trash2Icon,
} from "lucide-react";

import { Markdown } from "@/components/markdown";
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
import {
  type AgentSummary,
  fetchSkill,
  fetchSkills,
  removeSkill,
  type Skill,
  type SkillOwner,
  type SkillSummary,
  uploadSkill,
} from "@/lib/api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A SKILL.md without its frontmatter. */
const body = (content: string | undefined) =>
  (content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();

/** The files of a picked folder by their path inside it, hidden files left out. */
async function readFolder(files: FileList) {
  const read: Record<string, string> = {};
  for (const file of Array.from(files)) {
    const path = file.webkitRelativePath || file.name;
    if (path.split("/").some((part) => part.startsWith("."))) continue;
    read[path] = await file.text();
  }
  return read;
}

/**
 * Header button that opens the skills an agent can use: its own, and the person's, which every agent shares. A skill
 * is a folder with a SKILL.md and any files it points to, uploaded as a folder or a zip.
 */
export function Skills({ agent }: { agent: AgentSummary }) {
  const own = React.useMemo<SkillOwner>(() => ({ kind: "agent", agentId: agent.id }), [agent.id]);
  const person = React.useMemo<SkillOwner>(() => ({ kind: "person" }), []);
  const [skills, setSkills] = React.useState<{ own: SkillSummary[]; person: SkillSummary[] }>();
  const [error, setError] = React.useState<string>();

  const reload = React.useCallback(async () => {
    const [ownSkills, personSkills] = await Promise.all([fetchSkills(own), fetchSkills(person)]);
    setSkills({ own: ownSkills, person: personSkills });
  }, [own, person]);

  React.useEffect(() => {
    setSkills(undefined);
    void reload().catch((cause: unknown) => setError(errorText(cause)));
  }, [reload]);

  const ownNames = new Set(skills?.own.map((skill) => skill.name));
  const count =
    (skills?.own.length ?? 0) + (skills?.person.filter((s) => !ownNames.has(s.name)).length ?? 0);

  return (
    <Sheet onOpenChange={(open) => open && void reload().catch(() => {})}>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <BookOpenIcon />
        Skills
        {count > 0 && <span className="text-muted-foreground">{count}</span>}
      </SheetTrigger>
      <SheetContent className="data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Skills</SheetTitle>
          <SheetDescription>
            Instructions {agent.name} reads when a task matches a skill's description. A skill is a
            folder with a SKILL.md and any files it points to; upload it as a folder or a zip.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SkillGroup
            title={`${agent.name}'s skills`}
            description="Only this agent uses them. One with the same name as a shared skill replaces it here."
            owner={own}
            skills={skills?.own}
            onChange={reload}
            onError={setError}
          />
          <SkillGroup
            title="Shared skills"
            description="Every agent on your team can use them."
            owner={person}
            skills={skills?.person}
            overridden={ownNames}
            onChange={reload}
            onError={setError}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SkillGroup({
  title,
  description,
  owner,
  skills,
  overridden,
  onChange,
  onError,
}: {
  title: string;
  description: string;
  owner: SkillOwner;
  skills: SkillSummary[] | undefined;
  /** Names this agent overrides with its own skill. */
  overridden?: ReadonlySet<string>;
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const folderInput = React.useRef<HTMLInputElement>(null);
  const zipInput = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);

  async function upload(load: () => Promise<Blob | Record<string, string>>) {
    setUploading(true);
    onError(undefined);
    try {
      await uploadSkill(owner, await load());
      await onChange();
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => folderInput.current?.click()}
          >
            <FolderUpIcon />
            Folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => zipInput.current?.click()}
          >
            <FileArchiveIcon />
            Zip
          </Button>
        </div>
        <input
          ref={folderInput}
          type="file"
          className="hidden"
          {...{ webkitdirectory: "" }}
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) void upload(() => readFolder(files));
            event.target.value = "";
          }}
        />
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(async () => file);
            event.target.value = "";
          }}
        />
      </div>
      {skills?.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No skills yet.
        </p>
      )}
      {skills?.map((skill) => (
        <SkillItem
          key={skill.name}
          owner={owner}
          skill={skill}
          overridden={overridden?.has(skill.name) ?? false}
          onRemoved={onChange}
          onError={onError}
        />
      ))}
    </section>
  );
}

function SkillItem({
  owner,
  skill,
  overridden,
  onRemoved,
  onError,
}: {
  owner: SkillOwner;
  skill: SkillSummary;
  overridden: boolean;
  onRemoved: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [full, setFull] = React.useState<Skill>();
  const [file, setFile] = React.useState<string>();
  const [confirm, setConfirm] = React.useState(false);

  async function remove() {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    try {
      await removeSkill(owner, skill.name);
      await onRemoved();
    } catch (cause) {
      onError(errorText(cause));
    }
  }

  return (
    <Collapsible
      className="rounded-md border"
      onOpenChange={(open) => {
        if (open && full === undefined) {
          void fetchSkill(owner, skill.name).then(setFull, (cause: unknown) =>
            onError(errorText(cause)),
          );
        }
      }}
    >
      <CollapsibleTrigger className="group flex w-full items-start gap-2 p-3 text-left">
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-sm font-medium">
            {skill.name}
            {overridden && (
              <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                replaced by this agent's own
              </span>
            )}
          </span>
          <span className="text-sm text-muted-foreground">{skill.description}</span>
        </span>
        {skill.files.length > 0 && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {skill.files.length + 1} files
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t px-4 py-3">
        {skill.files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {["SKILL.md", ...skill.files].map((path) => (
              <Button
                key={path}
                variant={(file ?? "SKILL.md") === path ? "secondary" : "ghost"}
                size="sm"
                className="font-mono text-xs"
                onClick={() => setFile(path)}
              >
                <FileTextIcon />
                {path}
              </Button>
            ))}
          </div>
        )}
        {full === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : file === undefined || file === "SKILL.md" ? (
          <Markdown>{body(full.content["SKILL.md"])}</Markdown>
        ) : file.endsWith(".md") ? (
          <Markdown>{full.content[file] ?? ""}</Markdown>
        ) : (
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
            {full.content[file]}
          </pre>
        )}
        <div className="flex justify-end">
          <Button variant="destructive" size="sm" onClick={() => void remove()}>
            <Trash2Icon />
            {confirm ? `Remove ${skill.name}?` : "Remove"}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
