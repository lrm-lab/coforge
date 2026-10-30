import { useCallback, useState } from "react";
import { Beaker01 } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import {
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsPage,
} from "#src/components/settings-layout";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { getExperiments, setExperiment } from "./experiments.functions";

type Experiment = Awaited<ReturnType<typeof getExperiments>>["experiments"][number];

const EXPERIMENT_TEXT: Record<
  Experiment["key"],
  { name: () => string; description: () => string }
> = {
  taskConversations: {
    name: () => m.experiments_task_conversations(),
    description: () => m.experiments_task_conversations_description(),
  },
};

/** The Workspace's cache is cleared on a Workspace switch, so the key needs no Workspace id. */
const EXPERIMENTS_QUERY_KEY = ["settings-experiments"];

/** Why a switch did not save: a Computer that must be upgraded first is named, anything else is
 * the plain failure. */
function saveErrorText(error: unknown) {
  if (isAppError(error) && error.errorId === "computers-need-upgrade" && error.details)
    return m.experiments_computers_need_upgrade({
      computers: String(error.details.computers),
      version: String(error.details.version),
    });
  return m.experiments_save_error();
}

type ExperimentsData = Awaited<ReturnType<typeof getExperiments>>;

/**
 * The experiments this Workspace may try, read only for an owner or admin (`enabled`). A switch
 * made elsewhere arrives as `workspace.features.changed.v1` and the list is read again.
 */
export function useWorkspaceExperiments(enabled: boolean) {
  const load = useServerFn(getExperiments);
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  useRealtimeSubscription({
    channel: enabled && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: useCallback(
      (publication: { data: unknown }) => {
        if (decodeWorkspaceFeaturesChangedEvent(publication.data)?.workspaceId === workspaceId)
          void queryClient.invalidateQueries({ queryKey: EXPERIMENTS_QUERY_KEY });
      },
      [queryClient, workspaceId],
    ),
  });
  return useQuery({ queryKey: EXPERIMENTS_QUERY_KEY, queryFn: () => load(), enabled });
}

/** Whether there is an experiment to manage; `undefined` until the list has been read. */
export function hasExperiments({ data }: UseQueryResult<ExperimentsData>) {
  return data && data.canManage && data.experiments.length > 0;
}

/**
 * Settings → Administration → Experiments: the features this Workspace may try, one switch each,
 * for the whole Workspace. Settings shows it only while `hasExperiments` holds.
 */
export function ExperimentsSettings({
  experiments,
}: {
  experiments: UseQueryResult<ExperimentsData>;
}) {
  const save = useServerFn(setExperiment);
  const queryClient = useQueryClient();
  // The experiments switched since the page loaded: one that needs a reload offers it until then.
  const [changed, setChanged] = useState<ReadonlySet<Experiment["key"]>>(new Set());
  const toggle = useMutation({
    mutationFn: (change: { key: Experiment["key"]; enabled: boolean }) => save({ data: change }),
    onSuccess: (saved) => {
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
    // A save can fail because the Workspace stopped offering the experiment: re-read the list.
    onError: () => queryClient.invalidateQueries({ queryKey: EXPERIMENTS_QUERY_KEY }),
  });

  return (
    <SettingsPage>
      {experiments.isPending ? (
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
        <SettingsGroup icon={Beaker01} label={m.settings_experiments()}>
          <SettingsCard>
            {experiments.data.experiments.map((experiment) => {
              const text = EXPERIMENT_TEXT[experiment.key];
              const failed = toggle.isError && toggle.variables.key === experiment.key;
              return (
                <div key={experiment.key} className="flex flex-col gap-2">
                  <SettingsField inline label={text.name()} description={text.description()}>
                    <div className="flex shrink-0 items-center gap-3">
                      {experiment.reload && changed.has(experiment.key) && (
                        <Button
                          color="link-color"
                          size="sm"
                          onPress={() => window.location.reload()}
                        >
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
                        isDisabled={toggle.isPending}
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
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
