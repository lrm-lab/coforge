import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import {
  agentMigrationStatusLine,
  agentMigrationSteps,
  isAgentMigrationInProgress,
} from "#src/features/agents/agent-migration";
import { getAgentMigration } from "#src/features/agents/agent-migrations.functions";

const PROGRESS_POLL_MS = 3_000;

export function useAgentMigrationStatus(agentId: string, enabled = true) {
  const readMigration = useServerFn(getAgentMigration);
  return useQuery({
    queryKey: ["agent-migration", agentId] as const,
    queryFn: () => readMigration({ data: { agentId } }),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.migration && isAgentMigrationInProgress(query.state.data.migration.state)
        ? PROGRESS_POLL_MS
        : false,
  });
}

export function AgentMigrationStatus({
  migration,
  targetName,
  sourceName,
  onCancel,
  canceling,
}: {
  migration: { state: string; errorCode: string | null };
  targetName: string;
  sourceName: string;
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const inProgress = isAgentMigrationInProgress(migration.state);
  return (
    <div className="grid gap-2 rounded-lg border border-secondary px-3 py-2.5">
      <p
        role="status"
        className={
          migration.state === "failed" ? "text-sm text-error-primary" : "text-sm text-secondary"
        }
      >
        {agentMigrationStatusLine(migration, targetName, sourceName)}
      </p>
      {(inProgress || migration.state === "completed") && (
        <ol className="grid gap-1 text-sm">
          {agentMigrationSteps(migration.state).map((step) => (
            <li
              key={step.label}
              className={
                step.status === "pending"
                  ? "flex items-center gap-2 text-quaternary"
                  : "flex items-center gap-2 text-secondary"
              }
            >
              <span
                aria-hidden="true"
                className={
                  step.status === "done"
                    ? "size-2 rounded-full bg-success-solid"
                    : step.status === "current"
                      ? "size-2 rounded-full bg-fg-secondary motion-safe:animate-pulse"
                      : "size-2 rounded-full bg-quaternary"
                }
              />
              <span>{step.label}</span>
              <span className="sr-only">
                {step.status === "done"
                  ? m.agent_migration_step_done()
                  : step.status === "current"
                    ? m.agent_migration_step_current()
                    : m.agent_migration_step_pending()}
              </span>
            </li>
          ))}
        </ol>
      )}
      {inProgress && onCancel && (
        <Button
          color="secondary"
          size="sm"
          className="justify-self-start"
          isDisabled={canceling}
          isLoading={canceling}
          onPress={onCancel}
        >
          {m.agent_migration_cancel()}
        </Button>
      )}
    </div>
  );
}

export function AgentMigrationCancelBody({ switched }: { switched: boolean }) {
  return (
    <p className="px-6 pt-4 text-sm text-secondary">
      {switched
        ? m.agent_migration_cancel_after_switch()
        : m.agent_migration_cancel_before_switch()}
    </p>
  );
}

export function notStartedAfterMove(
  moved:
    | {
        direct?: boolean;
        startPublished?: boolean;
        computerAccessRevoked?: boolean;
      }
    | null
    | undefined,
  targetName: string,
): { computerName: string; assigned: boolean } | null {
  return moved?.direct === true && moved.startPublished === false
    ? { computerName: targetName, assigned: moved.computerAccessRevoked !== true }
    : null;
}

const notStartedKey = (agentId: string) => ["agent-migration-not-started", agentId] as const;

export function writeAgentMigrationNotStarted(
  queryClient: QueryClient,
  agentId: string,
  value: { computerName: string; assigned: boolean } | null,
) {
  queryClient.setQueryData(notStartedKey(agentId), value);
}

export function useAgentMigrationNotStarted(agentId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: notStartedKey(agentId),
    queryFn: () => null as { computerName: string; assigned: boolean } | null,
    enabled: false,
  });
  return {
    notStarted: query.data ?? null,
    setNotStarted: (value: { computerName: string; assigned: boolean } | null) =>
      writeAgentMigrationNotStarted(queryClient, agentId, value),
  };
}

export function AgentPlacementResult({
  agentId,
  agentOnline,
}: {
  agentId: string;
  agentOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const { notStarted: notStartedOn } = useAgentMigrationNotStarted(agentId);
  useEffect(() => {
    if (agentOnline && notStartedOn) writeAgentMigrationNotStarted(queryClient, agentId, null);
  }, [agentOnline, notStartedOn, queryClient, agentId]);

  return notStartedOn && !agentOnline ? <AgentMigrationNotStarted {...notStartedOn} /> : null;
}

export function AgentMigrationNotStarted({
  computerName,
  assigned,
}: {
  computerName: string;
  assigned: boolean;
}) {
  return (
    <Alert
      color="warning"
      description={
        assigned
          ? m.agent_migration_direct_not_started_assigned({ computer: computerName })
          : m.agent_migration_direct_not_started_moved({ computer: computerName })
      }
    />
  );
}

export function AgentMigrationRefusalNotice({
  message,
  link,
}: {
  message: string;
  link: { href: string; label: string } | null;
}) {
  return (
    <Alert
      color="warning"
      className="mx-6 mt-4"
      description={
        <div className="grid gap-1">
          <p>{message}</p>
          {link && (
            <a
              href={link.href}
              className="justify-self-start font-semibold text-brand-secondary hover:underline"
            >
              {link.label}
            </a>
          )}
        </div>
      }
    />
  );
}
