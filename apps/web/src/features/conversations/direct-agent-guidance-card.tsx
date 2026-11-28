import { Monitor01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { StatusDot, type StatusTone } from "#src/components/ui/status-dot";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { DirectAgentGuidance } from "./direct-agent-availability";

type GuidanceCopy = {
  tone: StatusTone;
  title: string;
  description: string;
  bannerText: string;
  primaryLabel?: string;
  onPrimary?: () => void;
};

/** Explains why an Agent DM cannot reply right now and links to Computers or the Agent's status. */
export function DirectAgentGuidanceCard({
  guidance,
  variant,
  onOpenAgentProfile,
}: {
  guidance: DirectAgentGuidance;
  variant: "empty" | "banner";
  onOpenAgentProfile?: () => void;
}) {
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();

  const copy: GuidanceCopy = (() => {
    switch (guidance.kind) {
      case "no_computer":
        return {
          tone: "unknown",
          title: m.dm_agent_no_computer_title({ name: guidance.agentName }),
          description: m.dm_agent_no_computer_description(),
          bannerText: m.dm_agent_no_computer_banner({ name: guidance.agentName }),
          primaryLabel: m.dm_agent_connect_computer(),
          onPrimary: () =>
            void navigate({ to: "/w/$workspaceSlug/computers", params: { workspaceSlug } }),
        };
      case "offline":
        return {
          tone: guidance.alertText ? "error" : "offline",
          title: guidance.alertText
            ? `${guidance.agentName}: ${guidance.alertText}`
            : m.dm_agent_offline_title({ name: guidance.agentName }),
          description: guidance.alertDetail || m.dm_agent_offline_description(),
          bannerText: guidance.alertText
            ? guidance.alertDetail
              ? `${guidance.alertText} — ${guidance.alertDetail}`
              : guidance.alertText
            : m.dm_agent_offline_banner({ name: guidance.agentName }),
          primaryLabel: m.dm_agent_open_computers(),
          onPrimary: guidance.computerId
            ? () =>
                void navigate({
                  to: "/w/$workspaceSlug/computer/$computerId",
                  params: { workspaceSlug, computerId: guidance.computerId! },
                })
            : () => void navigate({ to: "/w/$workspaceSlug/computers", params: { workspaceSlug } }),
        };
      case "external_offline":
        return {
          tone: guidance.alertText ? "error" : "external",
          title: guidance.alertText
            ? `${guidance.agentName}: ${guidance.alertText}`
            : m.dm_agent_offline_title({ name: guidance.agentName }),
          description: guidance.alertDetail || m.dm_agent_external_offline_description(),
          bannerText: guidance.alertText
            ? guidance.alertDetail
              ? `${guidance.alertText} — ${guidance.alertDetail}`
              : guidance.alertText
            : m.dm_agent_external_offline_banner({ name: guidance.agentName }),
        };
    }
  })();

  const actions = (copy.primaryLabel || onOpenAgentProfile) && (
    <div
      className={
        variant === "empty"
          ? "mt-3.5 flex flex-wrap items-center gap-2 pl-4.5"
          : "flex shrink-0 flex-wrap items-center gap-2"
      }
    >
      {copy.primaryLabel && copy.onPrimary && (
        <Button
          type="button"
          color="secondary"
          size="sm"
          iconLeading={Monitor01}
          className="pointer-coarse:min-h-10"
          onPress={copy.onPrimary}
        >
          {copy.primaryLabel}
        </Button>
      )}
      {onOpenAgentProfile && (
        <Button
          type="button"
          color={
            variant === "banner" && copy.primaryLabel
              ? "link-gray"
              : copy.primaryLabel
                ? "tertiary"
                : "secondary"
          }
          size="sm"
          className="pointer-coarse:min-h-10"
          onPress={onOpenAgentProfile}
        >
          {m.dm_agent_view_status()}
        </Button>
      )}
    </div>
  );

  if (variant === "empty") {
    return (
      <div
        data-direct-agent-guidance={guidance.kind}
        className="w-full max-w-md rounded-xl border border-secondary bg-secondary p-4 text-left"
      >
        <div className="flex items-start gap-2.5">
          <StatusDot tone={copy.tone} className="mt-1.5 size-2" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold break-words text-primary [overflow-wrap:anywhere]">
              {copy.title}
            </h3>
            <p className="mt-1 text-sm break-words text-tertiary [overflow-wrap:anywhere]">
              {copy.description}
            </p>
          </div>
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div
      data-direct-agent-guidance={guidance.kind}
      className="mx-4 mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-secondary bg-secondary px-3.5 py-2.5 md:mx-6"
    >
      <div className="flex min-w-[min(15rem,100%)] flex-1 items-start gap-2">
        <StatusDot tone={copy.tone} className="mt-1.5 size-2" />
        <p className="min-w-0 flex-1 text-sm break-words text-secondary [overflow-wrap:anywhere]">
          {copy.bannerText}
        </p>
      </div>
      {actions}
    </div>
  );
}
