import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { StatusDot } from "#src/components/ui/status-dot";
import type { AgentDiagnosticFacts } from "#src/features/agents/agent-diagnostics";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  agentReadinessLine,
  launchFailureNeedsRuntime,
  launchFailureReason,
  LAUNCH_FAILURE_FIXABLE,
  runtimeMissingKind,
  type AgentReadinessFacts,
  type LaunchFailureReason,
} from "./agent-readiness-line";
import { CopyDiagnosticsButton } from "./copy-diagnostics-button";
import type { AgentRetry } from "./agent-error-banner";

export type AgentReadinessNoteData = {
  readiness: AgentReadinessFacts;
  computer: {
    id: string;
    label: string;
    ownerLabel?: string;
    ownedByViewer: boolean;
  } | null;
  canManageAgentRole: boolean;
  canManageLogin: boolean;
  canStartAgent: boolean;
  canManage: boolean;
  agentOwnerLabel: string;
  runtimeLabel: string;
  workspaceSlug: string | null;
};

type Tone = "gray" | "orange" | "error";

const TONE: Record<Exclude<ReturnType<typeof agentReadinessLine>, null>, Tone> = {
  computer_updating: "gray",
  computer_offline: "orange",
  runtime_missing: "orange",
  runtime_login_required: "orange",
  launch_failed: "error",
};

function Marker({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <StatusDot
      tone={tone === "error" ? "error" : tone === "orange" ? "working" : "unknown"}
      className={cn("size-2", className)}
    />
  );
}

function reasonText(reason: LaunchFailureReason, runtime: string, computer: string): string {
  const args = { runtime, computer };
  switch (reason) {
    case "runtime_not_found":
      return m.agent_readiness_launch_not_found(args);
    case "runtime_not_installed":
      return m.agent_readiness_launch_not_installed(args);
    case "runtime_unusable":
      return m.agent_readiness_launch_unusable(args);
    case "runtime_unavailable":
      return m.agent_readiness_launch_unavailable(args);
    case "runtime_private":
      return m.agent_readiness_launch_private(args);
    case "runtime_version_too_old":
      return m.agent_readiness_launch_version_too_old(args);
    case "runtime_start_failed":
      return m.agent_readiness_launch_runtime_start_failed(args);
    case "model_not_found":
      return m.agent_readiness_launch_model_not_found(args);
    case "auth_failed":
      return m.agent_readiness_launch_auth_failed();
    case "agent_authorization_failed":
      return m.agent_readiness_launch_authorization_failed();
    case "model_provider_not_configured":
      return m.agent_readiness_launch_provider_not_configured();
    case "agent_environment_invalid":
      return m.agent_readiness_launch_environment_invalid();
    case "startup_deadline_exceeded":
      return m.agent_readiness_launch_timeout();
    case "stalled_restart_limit":
      return m.agent_readiness_launch_restart_limit();
    default:
      return m.agent_readiness_launch_generic();
  }
}

function runtimeMissingText(
  kind: ReturnType<typeof runtimeMissingKind>,
  args: { computer: string; runtime: string; owner: string },
  canFixComputer: boolean,
): string {
  switch (kind) {
    case "unusable":
      return canFixComputer
        ? m.agent_readiness_runtime_unusable_you(args)
        : m.agent_readiness_runtime_unusable_other(args);
    case "unconfirmed":
      return canFixComputer
        ? m.agent_readiness_runtime_unconfirmed_you(args)
        : m.agent_readiness_runtime_unconfirmed_other(args);
    case "unknown":
      return canFixComputer
        ? m.agent_readiness_runtime_unknown_you(args)
        : m.agent_readiness_runtime_unknown_other(args);
    default:
      return canFixComputer
        ? m.agent_readiness_runtime_missing_you(args)
        : m.agent_readiness_runtime_missing_other(args);
  }
}

const LINK_BUTTON = "*:data-text:decoration-fg-quaternary *:data-text:underline-offset-2";

export function AgentReadinessNote({
  data,
  agent,
  display,
  onViewLogs,
  onOpenSettings,
  needsManualStart,
  retry,
}: {
  data: AgentReadinessNoteData;
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  onViewLogs?: () => void;
  onOpenSettings?: () => void;
  needsManualStart?: boolean;
  retry?: Pick<AgentRetry, "onRetry" | "busy" | "deferred" | "note">;
}) {
  const navigate = useNavigate();
  const line = agentReadinessLine(data.readiness);
  if (!line) return null;
  const computer = data.computer?.label ?? "";
  const computerId = data.computer?.id;
  const owner = data.computer?.ownerLabel ?? "";
  const canFixComputer = Boolean(data.computer?.ownedByViewer) || data.canManageAgentRole;
  const runtime = data.runtimeLabel;

  let text: string;
  let action: ReactNode = null;
  let suffix: string | null = null;

  switch (line) {
    case "computer_updating":
      text = m.agent_readiness_computer_updating({ computer });
      break;
    case "computer_offline":
      text = data.computer?.ownedByViewer
        ? m.agent_readiness_computer_offline_you({ computer })
        : m.agent_readiness_computer_offline_other({ computer, owner });
      break;
    case "runtime_missing":
      text = runtimeMissingText(
        runtimeMissingKind(data.readiness.detail),
        { computer, runtime, owner },
        canFixComputer,
      );
      break;
    case "runtime_login_required": {
      const base = data.canManageLogin
        ? m.agent_readiness_login_you({ computer, runtime })
        : m.agent_readiness_login_other({ computer, runtime });
      text = data.canStartAgent ? `${base} ${m.agent_readiness_login_start()}` : base;
      if (data.canManageLogin && computerId && data.workspaceSlug) {
        const workspaceSlug = data.workspaceSlug;
        action = (
          <Button
            color="link-gray"
            size="sm"
            className={LINK_BUTTON}
            onPress={() =>
              void navigate({
                to: "/w/$workspaceSlug/computer/$computerId",
                params: { workspaceSlug, computerId },
              })
            }
          >
            {m.agent_readiness_sign_in()}
          </Button>
        );
      }
      break;
    }
    case "launch_failed": {
      const reason = launchFailureReason(data.readiness.detail);
      const named = !launchFailureNeedsRuntime(reason) || runtime !== "";
      text = reasonText(named ? reason : "generic", runtime, computer);
      const fixable = LAUNCH_FAILURE_FIXABLE.has(reason) && Boolean(onOpenSettings);
      action = (
        <>
          {data.canStartAgent && retry && (
            <Button
              color="link-gray"
              size="sm"
              className={LINK_BUTTON}
              isDisabled={retry.busy}
              onPress={retry.onRetry}
            >
              {retry.busy && !retry.deferred
                ? m.agent_control_start_pending()
                : m.agent_error_banner_retry()}
            </Button>
          )}
          {data.canStartAgent && retry?.note && <span className="text-tertiary">{retry.note}</span>}
          {onViewLogs && <CopyDiagnosticsButton agent={agent} display={display} />}
          {onViewLogs && (
            <Button color="link-gray" size="sm" className={LINK_BUTTON} onPress={onViewLogs}>
              {m.agent_error_banner_view_logs()}
            </Button>
          )}
          {data.canManage && fixable && onOpenSettings && (
            <Button color="link-gray" size="sm" className={LINK_BUTTON} onPress={onOpenSettings}>
              {m.agent_readiness_open_settings()}
            </Button>
          )}
        </>
      );
      if (!data.canStartAgent && !data.canManage) {
        suffix = m.agent_readiness_owner_action({ owner: data.agentOwnerLabel });
      }
      break;
    }
  }

  const tone = TONE[line];
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 flex-wrap items-start gap-x-2 gap-y-1 border-b border-secondary px-5 py-2.5 text-sm",
        tone === "error" && "bg-error-primary",
      )}
    >
      <span className="flex min-w-0 items-start gap-1.5">
        <Marker tone={tone} className="mt-1.5" />
        <span
          className={cn(
            "min-w-0 break-words",
            tone === "error" ? "text-error-primary" : "text-secondary",
          )}
        >
          {text}
          {needsManualStart && ` ${m.agent_automatic_start_stopped()}`}
        </span>
      </span>
      {suffix && <span className="min-w-0 break-words text-tertiary">{suffix}</span>}
      {action}
    </div>
  );
}
