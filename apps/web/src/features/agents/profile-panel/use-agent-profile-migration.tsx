import { useState } from "react";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { isAgentMigrationInProgress } from "#src/features/agents/agent-migration";
import { m } from "#src/paraglide/messages";
import { agentMigrationRuntime } from "./agent-profile-runtime";
import { AgentMigrationSection } from "./agent-migration-section";
import { AgentMigrationDialog } from "./agent-migration-dialog";
import { useAgentMigrationStatus, AgentPlacementResult } from "./agent-migration-status";

export function useAgentProfileMigration(
  agentId: string,
  profile: Awaited<ReturnType<typeof getAgentProfile>> | undefined,
  canManage: boolean,
  agentIsOnline: boolean,
) {
  const deleted = Boolean(profile?.deletedAt);
  const placeable = Boolean(
    profile &&
    canManage &&
    !deleted &&
    profile.systemKind == null &&
    profile.hosting !== "external" &&
    !profile.isWeeklyReportAssistant,
  );
  const migrationRuntime = agentMigrationRuntime(profile?.runtimeConfig);
  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);
  const openMigration = () => setMovingAgentId(agentId);
  const migrationStatus = useAgentMigrationStatus(agentId, placeable && !!migrationRuntime).data;
  const directAction =
    placeable &&
    migrationRuntime &&
    migrationStatus?.available &&
    migrationStatus.directPlacement &&
    !isAgentMigrationInProgress(migrationStatus.migration?.state ?? "")
      ? {
          label: migrationStatus.computerAccessRevoked
            ? m.agent_migration_action_change()
            : m.agent_migration_action_fresh(),
          onPress: openMigration,
        }
      : undefined;
  const section = profile && (profile.computer || placeable) && !deleted && migrationRuntime && (
    <AgentMigrationSection
      agentId={profile.id}
      onMove={openMigration}
      canMove={canManage}
      agentOnline={agentIsOnline}
    />
  );
  const dialog = movingAgentId === agentId &&
    canManage &&
    profile &&
    migrationRuntime &&
    migrationStatus?.available && (
      <AgentMigrationDialog
        key={agentId}
        agentId={agentId}
        agentName={profile.displayName || profile.name}
        currentComputerId={profile.computer?.id ?? null}
        runtime={migrationRuntime.runtime}
        model={migrationRuntime.model}
        direct={migrationStatus.directPlacement === true}
        revoked={migrationStatus.computerAccessRevoked === true}
        onClose={() => setMovingAgentId(null)}
      />
    );
  return {
    section,
    dialog,
    directAction,
    result: <AgentPlacementResult agentId={agentId} agentOnline={agentIsOnline} />,
  };
}
