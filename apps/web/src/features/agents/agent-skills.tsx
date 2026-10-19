import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, Globe01 } from "@untitledui/icons";
import { Button as AriaButton, Disclosure, DisclosurePanel } from "react-aria-components";
import type { AgentSkillsListResult, AgentSkillsScope } from "@lrm/coforge-sdk/internal";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type AgentSkillsLoadResult =
  | { status: "ready"; result: AgentSkillsListResult }
  | { status: "offline" | "timeout" | "unavailable" };

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "offline" | "timeout" | "unavailable" }
  | { status: "ready"; result: AgentSkillsListResult };

/**
 * The Profile tab's Skills section: a `Skills (N)` heading, a
 * single loading line, a reason line plus Retry on any non-ready state, and two source-grouped
 * lists (Global/Workspace) of one-line, expandable skill rows with no directory list, no
 * per-entry source column, and no "loaded" claim. Owner-only, same gate as before
 * (`agent-profile-tab.tsx`).
 */
export function AgentSkills({
  resetKey,
  onLoad,
}: {
  resetKey: string;
  onLoad: () => Promise<AgentSkillsLoadResult>;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    setState({ status: "loading" });
    try {
      const result = await onLoad();
      if (request.current !== current) return;
      setState(result);
    } catch {
      if (request.current === current) setState({ status: "error" });
    }
  }, [onLoad]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load, resetKey]);

  const count =
    state.status === "ready"
      ? state.result.global.entries.length + state.result.workspace.entries.length
      : 0;

  return (
    <section className="min-w-0 py-6">
      <h2 className="font-semibold">{m.agent_skills_title({ count })}</h2>
      {state.status === "loading" ? (
        <p role="status" className="mt-4 text-sm text-tertiary">
          {m.agent_skills_loading()}
        </p>
      ) : state.status === "ready" ? (
        <div className="mt-4 grid gap-6">
          <SkillGroup
            icon={Globe01}
            heading={m.agent_skills_global()}
            emptyCopy={m.agent_skills_global_empty()}
            scope={state.result.global}
          />
          <SkillGroup
            icon={Folder}
            heading={m.agent_skills_workspace()}
            emptyCopy={m.agent_skills_workspace_empty()}
            scope={state.result.workspace}
          />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-error-primary">
            {state.status === "offline"
              ? m.agent_skills_offline()
              : state.status === "timeout"
                ? m.agent_skills_timeout()
                : state.status === "unavailable"
                  ? m.agent_skills_unavailable()
                  : m.agent_skills_error()}
          </p>
          <Button size="sm" color="secondary" onPress={() => void load()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
    </section>
  );
}

function SkillGroup({
  icon: Icon,
  heading,
  emptyCopy,
  scope,
}: {
  icon: typeof Globe01;
  heading: string;
  emptyCopy: string;
  scope: AgentSkillsScope;
}) {
  const groups = groupBySourcePath(scope.entries);
  return (
    <section className="min-w-0" aria-labelledby={`skills-${heading}`}>
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden="true" className="size-4 text-tertiary" />
        <h3 id={`skills-${heading}`} className="text-sm font-semibold">
          {heading}
        </h3>
        <span className="text-sm text-tertiary">({scope.entries.length})</span>
      </div>
      {scope.entries.length === 0 ? (
        <p className="mt-2 text-sm text-tertiary">{emptyCopy}</p>
      ) : (
        <div className="mt-3 grid gap-4">
          {groups.map(([sourcePath, entries]) => (
            <div key={sourcePath} className="min-w-0">
              <p className="flex items-baseline gap-1.5 text-xs text-tertiary">
                <code className="truncate">{sourcePath}</code>
                <span>({entries.length})</span>
              </p>
              <div className="mt-2 grid gap-2">
                {entries.map((entry) => (
                  <SkillRow key={`${sourcePath}:${entry.name}`} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One skill: a single line (name, `/name` badge, then the description cut off with an ellipsis).
 * A skill with a description is a disclosure, collapsed by default and never persisted; pressing
 * the row shows the whole description wrapped below it.
 */
function SkillRow({ entry }: { entry: AgentSkillsScope["entries"][number] }) {
  const name = (
    <>
      <span className="max-w-3/5 shrink-0 truncate font-medium text-primary">
        {entry.displayName}
      </span>
      {entry.userInvocable && (
        <Badge color="gray" size="sm" className="shrink-0 font-mono">
          /{entry.name}
        </Badge>
      )}
    </>
  );
  if (!entry.description) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-secondary px-3 py-2 text-sm">
        <span aria-hidden="true" className="size-4 shrink-0" />
        {name}
      </div>
    );
  }
  return (
    <Disclosure className="min-w-0 rounded-lg border border-secondary">
      {({ isExpanded }) => (
        <>
          <AriaButton
            slot="trigger"
            className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-left text-sm outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-fg-quaternary transition-transform motion-reduce:transition-none",
                isExpanded && "rotate-90",
              )}
            />
            {name}
            {!isExpanded && (
              <span className="min-w-0 flex-1 truncate text-tertiary">{entry.description}</span>
            )}
          </AriaButton>
          <DisclosurePanel
            // A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves displayed: hide it outright.
            className={cn(
              "pr-3 pb-2.5 pl-8.5 text-sm break-words whitespace-pre-line text-tertiary",
              !isExpanded && "hidden",
            )}
          >
            {entry.description}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

function groupBySourcePath(entries: AgentSkillsScope["entries"]) {
  const groups = new Map<string, AgentSkillsScope["entries"]>();
  for (const entry of entries) {
    const existing = groups.get(entry.sourcePath);
    if (existing) existing.push(entry);
    else groups.set(entry.sourcePath, [entry]);
  }
  return [...groups.entries()];
}
