import {
  DotsHorizontal,
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
} from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";

/**
 * The profile header's actions when the panel is too narrow for its buttons: one menu of the same
 * three.
 */
export function AgentProfileActionsMenu({
  controls,
  onMessage,
  className,
}: {
  controls?: AgentRuntimeControls;
  /** Absent for a viewer who may not message this Agent. */
  onMessage?: () => void;
  className?: string;
}) {
  return (
    <span className={className}>
      <Dropdown.Root>
        <ButtonUtility icon={DotsHorizontal} size="sm" tooltip={m.agent_profile_actions()} />
        <Dropdown.Popover placement="bottom end" className="w-52">
          <Dropdown.Menu
            aria-label={m.agent_profile_actions()}
            onAction={(key) => {
              if (key === "message") onMessage?.();
              if (key === "start") controls?.submitStart();
              if (key === "stop") controls?.submitStop();
              if (key === "restart") controls?.openRestart("restart");
            }}
          >
            {onMessage && (
              <Dropdown.Item
                id="message"
                icon={MessageSquare}
                label={m.agent_profile_panel_message()}
              />
            )}
            {controls &&
              (controls.isOnline ? (
                <Dropdown.Item
                  id="stop"
                  icon={Stop}
                  label={m.agent_control_stop_agent()}
                  isDisabled={controls.startStopBusy}
                />
              ) : (
                <Dropdown.Item
                  id="start"
                  icon={Play}
                  label={m.agent_control_start()}
                  isDisabled={controls.startStopBusy}
                />
              ))}
            {controls && (
              <Dropdown.Item
                id="restart"
                icon={RotateCcw}
                label={m.agent_control_restart_reset_tooltip()}
              />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </span>
  );
}
