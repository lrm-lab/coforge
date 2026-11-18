import {
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  XClose as X,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PaneHeader } from "#src/components/layout/pane-header";
import { AgentProfileActionsMenu } from "./agent-profile-actions-menu";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import type { AgentMascot } from "#src/features/agents/agent-mascot";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { type AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";

/**
 * The Agent panel's `PaneHeader`: identity on the left of the title row, bordered icon buttons on
 * the right — Message, Start-or-Stop, Restart/Reset, then a plain Close. On a narrow panel Message
 * stays and the other two go in one menu (`AgentProfileActionsMenu`), so the name keeps the room.
 * The tabs fill the second row; the status and error lines come below the band. Rendered once by
 * the panel shell, not per tab. All four buttons use the official `ButtonUtility` with its
 * `tooltip` prop.
 */
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
  tabs,
}: {
  agent: {
    id: string;
    displayName: string;
    avatarUrl?: string | null;
    /** The face is unknown until a read provides it: an app's bot, or an Agent outside the
     * roster, waits with the neutral monogram instead of the id's mascot. */
    noIdDefault?: boolean;
  };
  /** The Agent's mascot key, once the profile has loaded: the avatar then moves. Until then, a
   * still picture. */
  mascot?: AgentMascot;
  /** True when this profile is an app's bot, which has no mascot: its picture stays still,
   * as on its card. Undefined while the profile is still loading. */
  appBot?: boolean | undefined;
  display?: AgentDisplaySnapshot;
  controls: AgentRuntimeControls;
  /** The viewer may message this Agent: any member a public one, only its creator a private one. */
  canMessage: boolean;
  /** The Agent was deleted: its profile is read-only, so the header offers no runtime control. */
  deleted?: boolean;
  onClose: () => void;
  /** Where the profile was opened from, when it is shown inside another page (a channel's
   * members): a Back button before the avatar returns there. */
  back?: { label: string; onPress: () => void };
  tabs: React.ReactNode;
}) {
  const openDirectConversation = useOpenDirectConversation();
  const message = () => void openDirectConversation({ agentId: agent.id });
  const header = (
    <PaneHeader className="@container/agent-header px-5" bar={tabs}>
      {back && (
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          className="-ml-1.5"
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
      <p className="min-w-0 flex-1 truncate text-md font-medium tracking-tight text-secondary">
        {agent.displayName}
      </p>
      {deleted && <DeletedAgentBadge />}
      <div className="flex items-center gap-2">
        {canMessage && (
          <ButtonUtility
            icon={MessageSquare}
            size="sm"
            tooltip={m.agent_profile_panel_message()}
            onClick={message}
          />
        )}
        {!deleted && (
          <>
            <AgentProfileActionsMenu className="flex @lg/agent-header:hidden" controls={controls} />
            <ButtonUtility
              icon={controls.isOnline ? Stop : Play}
              size="sm"
              className="hidden @lg/agent-header:inline-flex"
              isDisabled={controls.startStopBusy}
              tooltip={
                controls.isOnline
                  ? m.agent_control_stop_agent()
                  : [m.agent_control_start(), controls.startNote].filter(Boolean).join(" · ")
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
              className="hidden @lg/agent-header:inline-flex"
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
        className="-mr-1.5"
        tooltip={m.controls_close()}
        onClick={onClose}
      />
    </PaneHeader>
  );
  const statusLine = controls?.controlPendingLabel ?? controls?.controlFailureDetail;
  const submitError = controls?.startStopError ?? controls?.restartSubmitError;
  if (!submitError && !statusLine) return header;
  return (
    <>
      {header}
      {statusLine && (
        <p className="px-5 py-2 text-sm text-tertiary" role="status">
          {statusLine}
        </p>
      )}
      {submitError && (
        <p role="alert" className="px-5 py-2 text-sm text-error-primary">
          {submitError}
        </p>
      )}
    </>
  );
}
