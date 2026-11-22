import {
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  XClose as X,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { AgentProfileActionsMenu } from "./agent-profile-actions-menu";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import type { AgentMascot } from "#src/features/agents/agent-mascot";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { DELETED_AGENT_NAME_CLASS, DeletedAgentLabel } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";
import { type AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";

export function AgentProfileHeader({
  agent,
  mascot,
  appBot,
  display,
  controls,
  canMessage,
  deleted = false,
  onClose,
  back,
  pageHeading = false,
}: {
  agent: {
    id: string;
    displayName: string;
    avatarUrl?: string | null;
    noIdDefault?: boolean;
  };
  mascot?: AgentMascot;
  appBot?: boolean | undefined;
  display?: AgentDisplaySnapshot;
  controls: AgentRuntimeControls;
  canMessage: boolean;
  deleted?: boolean;
  onClose: () => void;
  back?: { label: string; onPress: () => void };
  pageHeading?: boolean;
}) {
  const openDirectConversation = useOpenDirectConversation();
  const message = () => void openDirectConversation({ agentId: agent.id });
  const Name = pageHeading ? "h1" : "p";
  const header = (
    <header className="@container/agent-header flex h-12 shrink-0 items-center gap-2 px-5 py-0">
      {back && (
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          className="-ms-1.5 any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 [&_svg]:rtl:rotate-180"
          tooltip={back.label}
          aria-label={back.label}
          onClick={back.onPress}
        />
      )}
      {mascot && !appBot ? (
        <AgentMascotAvatar
          mascot={mascot}
          name={agent.displayName}
          display={display}
          deleted={deleted}
          cornerDot
          announced
        />
      ) : (
        <AgentDisplayAvatar
          agentId={agent.id}
          name={agent.displayName}
          src={agent.avatarUrl}
          noIdDefault={agent.noIdDefault}
          display={display}
          deleted={deleted}
        />
      )}
      <Name
        className={cn(
          "min-w-0 flex-1 truncate text-md font-medium tracking-tight",
          deleted ? DELETED_AGENT_NAME_CLASS : "text-secondary",
        )}
      >
        {agent.displayName}
      </Name>
      {deleted && <DeletedAgentLabel />}
      <div className="flex items-center gap-2">
        {canMessage && (
          <ButtonUtility
            icon={MessageSquare}
            size="sm"
            className="any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11"
            tooltip={m.agent_profile_panel_message()}
            onClick={message}
          />
        )}
        {!deleted && (
          <>
            <AgentProfileActionsMenu
              className="flex any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 @lg/agent-header:hidden"
              controls={controls}
            />
            <ButtonUtility
              icon={controls.isOnline ? Stop : Play}
              size="sm"
              className="hidden any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 @lg/agent-header:inline-flex"
              isDisabled={controls.startStopBusy}
              tooltip={
                controls.isOnline
                  ? m.agent_control_stop_agent()
                  : [m.agent_control_start(), controls.startNote].filter(Boolean).join(" — ")
              }
              onClick={
                controls.isOnline
                  ? controls.submitStop
                  : () => controls.submitStart({ announce: true })
              }
            />
            <ButtonUtility
              icon={RotateCcw}
              size="sm"
              className="hidden any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 @lg/agent-header:inline-flex"
              isDisabled={controls.controlInFlight}
              tooltip={m.agent_control_restart_reset_tooltip()}
              onClick={() => controls.openRestart("restart")}
            />
          </>
        )}
      </div>
      <ButtonUtility
        icon={X}
        size="sm"
        color="tertiary"
        className="-me-1.5 any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11"
        tooltip={m.controls_close()}
        onClick={onClose}
      />
    </header>
  );
  const statusLine = controls?.controlPendingLabel ?? controls?.controlFailureDetail;
  const submitError = controls?.startStopError ?? controls?.restartSubmitError;
  if (!submitError && !statusLine) return header;
  return (
    <>
      {header}
      {statusLine && (
        <p className="px-5 pb-2 text-sm text-tertiary" role="status">
          {statusLine}
        </p>
      )}
      {submitError && (
        <p role="alert" className="px-5 pb-2 text-sm text-error-primary">
          {submitError}
        </p>
      )}
    </>
  );
}
