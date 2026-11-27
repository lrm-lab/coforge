import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, Beaker01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { SettingsCard, SettingsField, SettingsPage } from "#src/components/settings-layout";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import { m } from "#src/paraglide/messages";
import { AI_WORKBENCH_QUERY_KEY } from "./ai-workbench";
import {
  invalidateWeeklyReportsDependents,
  WEEKLY_REPORTS_QUERY_KEY,
} from "#src/features/records/weekly-reports-gate";
import { getExperiments, setExperiment } from "./experiments.functions";
type Experiment = Awaited<ReturnType<typeof getExperiments>>["experiments"][number];
const EXPERIMENT_TEXT: Record<
  Experiment["key"],
  {
    name: () => string;
    description: () => string;
  }
> = {
  drafts: {
    name: () => m.experiments_drafts(),
    description: () => m.experiments_drafts_description(),
  },
  aiWorkbench: {
    name: () => m.experiments_ai_workbench(),
    description: () => m.experiments_ai_workbench_description(),
  },
  teamMemory: {
    name: () => m.experiments_team_memory(),
    description: () => m.experiments_team_memory_description(),
  },
  weeklyReports: {
    name: () => m.experiments_weekly_reports(),
    description: () => m.experiments_weekly_reports_description(),
  },
};
const EXPERIMENTS_QUERY_KEY = ["settings-experiments"];
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
  const workspaceId = useCurrentWorkspaceId();
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
      if (saved.key === "weeklyReports") {
        queryClient.setQueryData(WEEKLY_REPORTS_QUERY_KEY, saved.enabled);
        invalidateWeeklyReportsDependents(queryClient, workspaceId);
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
    <div role="status" aria-label={m.experiments_loading()} className="grid gap-3">
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  ) : !experiments.data ? (
    <EmptyState
      size="page"
      role="alert"
      picture={<EmptyIcon icon={AlertCircle} />}
      title={m.experiments_load_error()}
      description={m.empty_load_failed_safe()}
      primaryAction={
        <RetryButton
          size="page"
          isRetrying={experiments.isRefetching}
          onPress={() => void experiments.refetch()}
        />
      }
    />
  ) : experiments.data.experiments.length === 0 ? (
    <EmptyState
      size="page"
      picture={<EmptyIcon icon={Beaker01} />}
      title={m.empty_experiments_none_title()}
      description={m.empty_experiments_none_description()}
    />
  ) : (
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
                {m.experiments_save_error()}
              </p>
            )}
          </div>
        );
      })}
    </SettingsCard>
  );
  return <SettingsPage>{content}</SettingsPage>;
}
