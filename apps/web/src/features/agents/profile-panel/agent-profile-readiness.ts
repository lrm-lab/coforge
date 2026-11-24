import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { humanLabel } from "#src/lib/human-label";
import { runtimeProviderLabel } from "../runtime-provider-display";
import type { AgentReadinessNoteData } from "./agent-readiness-note";

type LoadedAgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

export function agentProfileReadinessData(
  profile: LoadedAgentProfile | null | undefined,
  deleted: boolean,
  canManage: boolean,
  workspaceSlug: string,
): { needsManualStart: boolean; readinessData: AgentReadinessNoteData | undefined } {
  const needsManualStart =
    !!profile && "needsManualStart" in profile && profile.needsManualStart === true;
  const readiness =
    profile?.readiness.state === "ready" && needsManualStart
      ? { state: "launch_failed", detail: profile.failureReason }
      : profile?.readiness;
  const readinessData: AgentReadinessNoteData | undefined =
    profile && !deleted && readiness && readiness.state !== "ready"
      ? {
          readiness,
          failureReason: profile.failureReason,
          computer: profile.computer
            ? {
                id: profile.computer.id,
                label: profile.computer.label,
                ownerLabel: profile.computer.ownerLabel,
                ownedByViewer: profile.computer.ownedByViewer,
              }
            : null,
          canManageAgentRole: profile.canManageAgentRole,
          canManageLogin: profile.canManageRuntimeLogin,
          canStartAgent: profile.canControlAgentRuntime,
          canManage,
          agentOwnerLabel: humanLabel(profile.owner),
          runtimeLabel: profile.runtimeConfig
            ? runtimeProviderLabel(profile.runtimeConfig.runtime)
            : "",
          workspaceSlug,
        }
      : undefined;
  return { needsManualStart, readinessData };
}
