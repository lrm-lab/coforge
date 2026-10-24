import {
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  StopCircle,
  XClose as X,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import type { AgentMascot } from "#src/features/agents/agent-mascot";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";

/**
 * The panel's first band (48px, the same height as Thread's header): the Agent's identity on the
 * left, bordered icon buttons on the right — Message, Start-or-Stop, Restart/Reset, then a plain
 * Close. Available on every tab (rendered once by the panel shell, not per tab). All four use the
 * official `ButtonUtility` with its `tooltip` prop.
 */
export function AgentProfileHeader({
  agent,
  mascot,
  appBot = false,
  display,
  controls,
  canMessage,
  deleted = false,
  onClose,
  back,
}: {
  agent: {
    id: string;
    displayName: string;
    avatarUrl?: string | null;
  };
  /** The Agent's mascot key, once the profile has loaded: the avatar then moves. Until then, a
   * still picture. */
  mascot?: AgentMascot;
  /** The profile is an app's bot, which has no mascot: its picture stays still, as on its card. */
  appBot?: boolean;
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
}) {
  const openDirectConversation = useOpenDirectConversation();
  return (
    // Same 20px gutter as the panel body (px-5): the bordered utility buttons align by box edge,
    // while the borderless Close pulls -mr-1.5 so its glyph lands on the gutter
    // (docs/design/page-skeleton-and-density.md §8 optical alignment).
    <header className="flex h-12 shrink-0 items-center gap-2 px-5 py-0">
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
          display={display}
          deleted={deleted}
        />
      )}
      {/* The name alone: the avatar's dot carries the live status
          and the Profile tab the description. */}
      <p className="min-w-0 flex-1 truncate text-md font-medium tracking-tight text-secondary">
        {agent.displayName}
      </p>
      {deleted && <DeletedAgentBadge />}
      {canMessage && (
        <ButtonUtility
          icon={MessageSquare}
          size="sm"
          tooltip={m.agent_profile_panel_message()}
          onClick={() => void openDirectConversation({ agentId: agent.id })}
        />
      )}
      {!deleted && (
        <>
          {controls.isOnline &&
            (display?.activityKind === "working" ||
              display?.activityKind === "thinking" ||
              display?.detailKind === "runtime_stalled") && (
              <ButtonUtility
                icon={StopCircle}
                size="sm"
                isDisabled={controls.interruptPending}
                tooltip={m.agent_control_stop()}
                onClick={controls.interrupt}
              />
            )}
          <ButtonUtility
            icon={controls.isOnline ? Stop : Play}
            size="sm"
            isDisabled={controls.startStopBusy}
            tooltip={controls.isOnline ? m.agent_control_stop() : m.agent_control_start()}
            onClick={controls.pressStartOrStop}
          />
          <ButtonUtility
            icon={RotateCcw}
            size="sm"
            tooltip={m.agent_control_restart_reset_tooltip()}
            onClick={() => controls.openRestart("restart")}
          />
        </>
      )}
      <ButtonUtility
        icon={X}
        size="sm"
        color="tertiary"
        className="-mr-1.5"
        tooltip={m.controls_close()}
        onClick={onClose}
      />
    </header>
  );
}
