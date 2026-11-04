import { useEffect, useState } from "react";
import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { StatusDot } from "#src/components/ui/status-dot";
import { Spinner } from "#src/components/ui/spinner";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { ComputerInstallCommand } from "./computer-install-command";
import { CloudComputerStep } from "./cloud-computer-step";
import { ComputerTypeOption } from "./computer-type-option";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";

type ComputerType = "local" | "cloud";
export function AddComputerDialog({
  open,
  onOpenChange,
  installOrigin,
  workspaceSlug,
  connectedComputerName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installOrigin: string;
  workspaceSlug: string | null;
  connectedComputerName: string | null;
  onCreated: (computerId: string) => Promise<void>;
}) {
  const [computerType, setComputerType] = useState<ComputerType>("local");
  const [step, setStep] = useState<"choose" | "install" | "cloud">("choose");

  function close() {
    onOpenChange(false);
  }

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setStep("choose");
      setComputerType("local");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[calc(100vw-2rem)] max-w-2xl">
        <Dialog aria-describedby="add-computer-description">
          {() => (
            <>
              <DialogHeader
                title={
                  connectedComputerName ? m.computer_add_success_title() : m.computer_add_title()
                }
                description={
                  <span id="add-computer-description">
                    {step === "choose"
                      ? m.computer_add_description()
                      : step === "cloud"
                        ? m.computer_cloud_host_description()
                        : m.computer_install_description()}
                  </span>
                }
                onClose={close}
                className="sm:px-8 sm:pt-8"
              />

              {step === "choose" ? (
                <div className="grid gap-3 px-6 py-6 sm:grid-cols-2 sm:px-8">
                  <ComputerTypeOption
                    icon={Monitor}
                    label={m.computer_your_computer()}
                    description={m.computer_your_computer_description()}
                    selected={computerType === "local"}
                    onSelect={() => setComputerType("local")}
                  />
                  <ComputerTypeOption
                    icon={Cloud}
                    label={m.computer_cloud_computer()}
                    description={m.computer_cloud_computer_description()}
                    selected={computerType === "cloud"}
                    onSelect={() => setComputerType("cloud")}
                  />
                </div>
              ) : step === "cloud" ? (
                <CloudComputerStep
                  workspaceSlug={workspaceSlug}
                  onBack={() => setStep("choose")}
                  onCreated={onCreated}
                />
              ) : (
                <ComputerInstallCommand
                  installOrigin={installOrigin}
                  workspaceSlug={workspaceSlug}
                  status={
                    <div
                      role="status"
                      className="flex items-center gap-3 rounded-lg border border-secondary bg-secondary px-4 py-3"
                    >
                      {connectedComputerName ? (
                        <StatusDot tone="online" className="size-2" />
                      ) : (
                        <Spinner className="size-4 shrink-0 text-fg-quaternary" />
                      )}
                      <p className="text-sm font-medium text-primary">
                        {connectedComputerName
                          ? m.computer_add_success_description({ name: connectedComputerName })
                          : m.computer_waiting_for_connection()}
                      </p>
                    </div>
                  }
                />
              )}

              {step !== "cloud" && (
                <DialogActions className="px-6 sm:px-8 pt-4 pb-6">
                  <DialogCancel onPress={step === "choose" ? close : () => setStep("choose")}>
                    {step === "choose" ? m.controls_cancel() : m.controls_back()}
                  </DialogCancel>
                  {step === "choose" ? (
                    <DialogAction
                      onPress={() => setStep(computerType === "local" ? "install" : "cloud")}
                    >
                      {m.controls_next()}
                    </DialogAction>
                  ) : (
                    <DialogAction onPress={close} isDisabled={!connectedComputerName}>
                      {m.computer_connect_done()}
                    </DialogAction>
                  )}
                </DialogActions>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
