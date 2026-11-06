import { RefreshCcw01 as RotateCcw, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import type { AgentRuntimeControls } from "./agent-runtime-controls";

/**
 * The Restart/Reset session/Full reset dialog, rendered once per host (the Computer roster or the
 * Agent profile panel) and driven by that host's `useAgentRuntimeControls()` instance.
 */
export function AgentRestartDialog({
  agentName,
  control,
}: {
  agentName: string;
  control: AgentRuntimeControls;
}) {
  return (
    <ModalOverlay isOpen={control.restartOpen} onOpenChange={control.closeRestart}>
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="p-6 text-left">
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4">
                <Heading
                  slot="title"
                  className="min-w-0 text-md font-semibold text-primary wrap-anywhere"
                >
                  {m.agent_control_dialog_title({ name: agentName })}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  onClick={close}
                />
              </div>
              <Text slot="description" className="sr-only">
                {control.selected.description}
              </Text>
              <div
                className="grid min-h-0 gap-3 overflow-y-auto py-2"
                role="group"
                aria-label={m.agent_control_title()}
              >
                {control.options.map((option) => (
                  <Button
                    key={option.action}
                    color="secondary"
                    aria-label={option.label}
                    aria-pressed={control.action === option.action}
                    data-control-action={option.action}
                    className={`h-auto flex-col items-start whitespace-normal rounded-xl p-4 text-left ${control.action === option.action ? "border-brand bg-primary ring-1 ring-brand hover:bg-primary" : "hover:bg-secondary"}`}
                    onPress={() => control.setAction(option.action)}
                  >
                    <span className="block font-semibold">{option.label}</span>
                    <span className="mt-1 block text-sm font-normal text-tertiary">
                      {option.description}
                    </span>
                  </Button>
                ))}
                {control.destructive && (
                  <p className="px-1 text-sm text-tertiary">
                    {m.agent_control_confirm_description()}
                  </p>
                )}
              </div>
              <DialogActions className="mt-6 shrink-0">
                <DialogCancel className="min-w-28" onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  className="min-w-28"
                  color={control.destructive ? "primary-destructive" : "primary"}
                  data-control-submit
                  iconLeading={RotateCcw}
                  onPress={control.submitRestart}
                >
                  {control.selected.label}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
