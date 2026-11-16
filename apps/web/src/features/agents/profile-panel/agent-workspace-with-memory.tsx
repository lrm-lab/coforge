import { lazy, Suspense, useState, type ComponentProps } from "react";
import { ArrowLeft, BookOpen01, ChevronRight } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceExperiments } from "#src/features/settings/experiments-settings";
import { m } from "#src/paraglide/messages";
import { AgentWorkspaceTab } from "./agent-workspace-tab";

const MemoryPanel = lazy(() =>
  import("#src/features/platform-memory/memory-panel").then((module) => ({
    default: module.MemoryPanel,
  })),
);

type Props = Omit<ComponentProps<typeof AgentWorkspaceTab>, "beforeEntries"> & { owned: boolean };

export function AgentWorkspaceWithMemory(props: Props) {
  const workspaceId = useCurrentWorkspaceId();
  return <WorkspaceContent key={`${workspaceId}:${props.agentId}:${props.owned}`} {...props} />;
}

function WorkspaceContent({ owned, ...files }: Props) {
  const experiments = useWorkspaceExperiments();
  const enabled =
    experiments.data?.experiments.some(
      (experiment) => experiment.key === "platformMemory" && experiment.enabled,
    ) ?? false;
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<"files" | "memory">("files");
  const showingMemory = enabled && view === "memory";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={showingMemory ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <AgentWorkspaceTab
          {...files}
          beforeEntries={
            enabled ? (
              <div className="border-b border-secondary">
                <Button
                  color="tertiary"
                  iconLeading={BookOpen01}
                  iconTrailing={ChevronRight}
                  className="w-full justify-start rounded-none px-5 py-2.5"
                  onClick={() => {
                    setOpened(true);
                    setView("memory");
                  }}
                >
                  {m.memory_workspace_entry()}
                </Button>
              </div>
            ) : undefined
          }
        />
      </div>
      {opened && enabled ? (
        <div className={showingMemory ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <div className="flex shrink-0 items-center gap-2 border-b border-secondary px-3 py-2">
            <ButtonUtility
              icon={ArrowLeft}
              size="xs"
              color="tertiary"
              tooltip={m.agent_workspace_back()}
              onClick={() => setView("files")}
            />
            <span className="text-sm font-medium text-secondary">{m.memory_workspace_entry()}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Suspense
              fallback={
                <p role="status" className="px-5 py-4 text-sm text-secondary">
                  {m.memory_loading()}
                </p>
              }
            >
              <MemoryPanel agentId={files.agentId} canReadPersonal={owned} active={showingMemory} />
            </Suspense>
          </div>
        </div>
      ) : null}
    </div>
  );
}
