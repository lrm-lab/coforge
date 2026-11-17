import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { SettingsCard, SettingsField, SettingsPage } from "#src/components/settings-layout";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { AI_WORKBENCH_QUERY_KEY } from "./ai-workbench";
import { getExperiments, setExperiment } from "./experiments.functions";
type Experiment = Awaited<ReturnType<typeof getExperiments>>["experiments"][number];
const EXPERIMENT_TEXT: Record<
  Experiment["key"],
  {
    name: () => string;
    description: () => string;
  }
> = {
  taskConversations: {
    name: () => m.experiments_task_conversations(),
    description: () => m.experiments_task_conversations_description(),
  },
  drafts: {
    name: () => m.experiments_drafts(),
    description: () => m.experiments_drafts_description(),
  },
  artifacts: {
    name: () => m.experiments_artifacts(),
    description: () => m.experiments_artifacts_description(),
  },
  aiWorkbench: {
    name: () => m.experiments_ai_workbench(),
    description: () => m.experiments_ai_workbench_description(),
  },
  teamMemory: {
    name: () => m.experiments_team_memory(),
    description: () => m.experiments_team_memory_description(),
  },
};
const EXPERIMENTS_QUERY_KEY = ["settings-experiments"];
function saveErrorText(error: unknown) {
  if (isAppError(error) && error.errorId === "computers-need-upgrade" && error.details)
    return m.experiments_computers_need_upgrade({
      computers: String(error.details.computers),
      version: String(error.details.version),
    });
  return m.experiments_save_error();
}
type ExperimentsData = Awaited<ReturnType<typeof getExperiments>>;
export function useWorkspaceExperiments() {
  const load = useServerFn(getExperiments);
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: useCallback(
      (publication: { data: unknown }) => {
        if (decodeWorkspaceFeaturesChangedEvent(publication.data)?.workspaceId === workspaceId)
          void queryClient.invalidateQueries({ queryKey: EXPERIMENTS_QUERY_KEY });
      },
      [queryClient, workspaceId],
    ),
  });
  return useQuery({ queryKey: EXPERIMENTS_QUERY_KEY, queryFn: () => load() });
}
export function ExperimentsSettings({
  experiments,
}: {
  experiments: UseQueryResult<ExperimentsData>;
}) {
  const save = useServerFn(setExperiment);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [changed, setChanged] = useState<ReadonlySet<Experiment["key"]>>(new Set());
  const toggle = useMutation({
    mutationFn: (change: { key: Experiment["key"]; enabled: boolean }) => save({ data: change }),
    onSuccess: (saved) => {
      if (saved.key === "aiWorkbench") {
        queryClient.setQueryData(AI_WORKBENCH_QUERY_KEY, saved.enabled);
        void router.invalidate();
      }
      setChanged((keys) => new Set(keys).add(saved.key));
      queryClient.setQueryData(
        EXPERIMENTS_QUERY_KEY,
        (data: ExperimentsData | undefined) =>
          data && {
            ...data,
            experiments: data.experiments.map((item) => (item.key === saved.key ? saved : item)),
          },
      );
    },
    onError: () => queryClient.invalidateQueries({ queryKey: EXPERIMENTS_QUERY_KEY }),
  });
  const content = experiments.isPending ? (
    <p className="text-sm text-tertiary">{m.experiments_loading()}</p>
  ) : !experiments.data ? (
    <div className="flex flex-col items-start gap-3">
      <p role="alert" className="text-sm text-error-primary">
        {m.experiments_load_error()}
      </p>
      <Button color="secondary" size="sm" onPress={() => void experiments.refetch()}>
        {m.controls_retry()}
      </Button>
    </div>
  ) : (
    experiments.data.experiments.length > 0 && (
      <SettingsCard>
        {experiments.data.experiments.map((experiment) => {
          const text = EXPERIMENT_TEXT[experiment.key];
          const failed = toggle.isError && toggle.variables.key === experiment.key;
          return (
            <div key={experiment.key} className="flex flex-col gap-2">
              <SettingsField inline label={text.name()} description={text.description()}>
                <div className="flex shrink-0 items-center gap-3">
                  {experiment.reload && changed.has(experiment.key) && (
                    <Button color="link-color" size="sm" onPress={() => window.location.reload()}>
                      {m.experiments_reload()}
                    </Button>
                  )}
                  <Toggle
                    size="md"
                    aria-label={text.name()}
                    isSelected={
                      toggle.isPending && toggle.variables.key === experiment.key
                        ? toggle.variables.enabled
                        : experiment.enabled
                    }
                    isDisabled={toggle.isPending || !experiments.data.canManage}
                    onChange={(enabled) => toggle.mutate({ key: experiment.key, enabled })}
                  />
                </div>
              </SettingsField>
              {failed && (
                <p role="alert" className="text-sm text-error-primary">
                  {saveErrorText(toggle.error)}
                </p>
              )}
            </div>
          );
        })}
      </SettingsCard>
    )
  );
  return <SettingsPage>{content}</SettingsPage>;
}
