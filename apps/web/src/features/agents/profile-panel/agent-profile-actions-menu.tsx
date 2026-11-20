import {
  DotsVertical,
  SwitchHorizontal01,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
} from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";

export function AgentProfileActionsMenu({
  controls,
  computerAction,
  className,
}: {
  controls: AgentRuntimeControls;
  className?: string;
  computerAction?: { label: string; onPress: () => void };
}) {
  return (
    <span className={className}>
      <Dropdown.Root>
        <ButtonUtility icon={DotsVertical} size="sm" tooltip={m.agent_profile_actions()} />
        <Dropdown.Popover placement="bottom end" className="w-60">
          <Dropdown.Menu
            aria-label={m.agent_profile_actions()}
            onAction={(key) => {
              if (key === "computer") computerAction?.onPress();
              if (key === "start") controls.submitStart({ announce: true });
              if (key === "stop") controls.submitStop();
              if (key === "restart") controls.openRestart("restart");
            }}
          >
            {computerAction && (
              <Dropdown.Item id="computer" icon={SwitchHorizontal01} label={computerAction.label} />
            )}
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
                textValue={m.agent_control_start()}
                isDisabled={controls.startStopBusy}
              >
                <span className="flex flex-col">
                  <span>{m.agent_control_start()}</span>
                  {!computerAction && controls.startNote && (
                    <span className="text-xs whitespace-normal text-tertiary">
                      {controls.startNote}
                    </span>
                  )}
                </span>
              </Dropdown.Item>
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
