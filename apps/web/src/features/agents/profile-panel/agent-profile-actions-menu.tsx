import { DotsVertical, Play, RefreshCcw01 as RotateCcw, Stop } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";

/** The profile header's Start-or-Stop and Restart when the panel is too narrow for their buttons. */
export function AgentProfileActionsMenu({
  controls,
  className,
}: {
  controls: AgentRuntimeControls;
  className?: string;
}) {
  return (
    <span className={className}>
      <Dropdown.Root>
        <ButtonUtility icon={DotsVertical} size="sm" tooltip={m.agent_profile_actions()} />
        <Dropdown.Popover placement="bottom end" className="w-60">
          <Dropdown.Menu
            aria-label={m.agent_profile_actions()}
            onAction={(key) => {
              if (key === "start") controls.submitStart();
              if (key === "stop") controls.submitStop();
              if (key === "restart") controls.openRestart("restart");
            }}
          >
            {controls.isOnline ? (
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
            )}
            <Dropdown.Item
              id="restart"
              icon={RotateCcw}
              label={m.agent_control_restart_reset_tooltip()}
              isDisabled={controls.controlInFlight}
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </span>
  );
}
