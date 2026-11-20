import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import {
  agentMigrationStatusLine,
  agentMigrationSteps,
  isAgentMigrationInProgress,
} from "#src/features/agents/agent-migration";
import { getAgentMigration } from "#src/features/agents/agent-migrations.functions";

/** How often a move in progress is read again; each stage takes seconds to minutes. */
const PROGRESS_POLL_MS = 3_000;

/**
 * The Agent's latest move and where it can be moved from, read again every few seconds while a
 * move is going. The Profile reads it too, to lead with the move when the Agent's Computer was
 * revoked; both share the one query.
 */
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

/** One line on where the Agent's latest move stands, with a cancel while it is going. */
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

/** What canceling does, which depends on whether the Agent has already switched Computers. */
export function AgentMigrationCancelBody({ switched }: { switched: boolean }) {
  return (
    <p className="px-6 pt-4 text-sm text-secondary">
      {switched
        ? m.agent_migration_cancel_after_switch()
        : m.agent_migration_cancel_before_switch()}
    </p>
  );
}

/**
 * Where a direct placement (#coforge:#732) left the Agent unstarted: the target's name when the
 * move placed it but its start did not go out (`startPublished: false`), so the Profile says to
 * start it rather than reading the move as done; else null.
 */
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

/** A direct placement that did not start: what happened and what to press. */
export function AgentMigrationNotStarted({
  computerName,
  assigned,
}: {
  computerName: string;
  /** The Agent had no Computer before (a first assignment), not a revoked one it left. */
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

/** Why the move was refused, with a link to the page where it can be fixed. */
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
