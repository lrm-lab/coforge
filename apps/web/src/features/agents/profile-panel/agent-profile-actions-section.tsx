import type { ReactNode } from "react";
import { Archive, Play, RefreshCcw01 as RotateCcw, Stop } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

export function AgentProfileActionsSection({
  isExternal,
  controls,
  migration,
  onStartDelete,
}: {
  isExternal: boolean;
  controls: AgentRuntimeControls;
  migration?: ReactNode;
  onStartDelete?: () => void;
}) {
  return (
    <section className="px-6 py-5">
      <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_actions()}</p>
      <div className="mt-3 flex flex-col gap-2">
        {migration}
        {isExternal ? (
          controls.isOnline ? (
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={Stop}
              isDisabled={controls.startStopBusy}
              onPress={controls.submitStop}
            >
              {m.external_agent_disable()}
            </Button>
          ) : (
            <p className="text-sm text-tertiary">{m.external_agent_disabled_note()}</p>
          )
        ) : (
          <>
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={controls.isOnline ? Stop : Play}
              isDisabled={controls.startStopBusy}
              onPress={controls.isOnline ? controls.submitStop : () => controls.submitStart()}
            >
              {controls.isOnline ? m.agent_profile_action_stop() : m.agent_profile_action_start()}
            </Button>
            {(controls.controlPendingLabel ?? controls.startNote) && (
              <p className="text-sm text-tertiary" role="status">
                {controls.controlPendingLabel ?? controls.startNote}
              </p>
            )}
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={RotateCcw}
              isDisabled={controls.controlInFlight}
              onPress={() => controls.openRestart("restart")}
            >
              {m.agent_control_restart_reset_tooltip()}
            </Button>
          </>
        )}
        {onStartDelete && (
          <Button
            color="secondary-destructive"
            className="mt-1 w-full justify-center"
            iconLeading={Archive}
            onPress={onStartDelete}
          >
            {m.agent_profile_action_delete()}
          </Button>
        )}
      </div>
    </section>
  );
}
