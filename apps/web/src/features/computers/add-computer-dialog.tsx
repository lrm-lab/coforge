import { useEffect, useState } from "react";
import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { m } from "#src/paraglide/messages";
import { ComputerInstallCommand } from "./computer-install-command";
import { CloudComputerStep } from "./cloud-computer-step";
import { ComputerTypeOption } from "./computer-type-option";
import { DialogHeader } from "#src/components/application/modals/dialog-header";

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
                  connectedComputerName={connectedComputerName}
                />
              )}

              {step !== "cloud" && (
                <div className="flex items-center justify-end gap-3 border-t border-secondary px-6 py-4 sm:px-8">
                  <Button
                    color="secondary"
                    onPress={step === "choose" ? close : () => setStep("choose")}
                  >
                    {step === "choose" ? m.controls_cancel() : m.controls_back()}
                  </Button>
                  {step === "choose" ? (
                    <Button onPress={() => setStep(computerType === "local" ? "install" : "cloud")}>
                      {m.controls_next()}
                    </Button>
                  ) : (
                    <Button onPress={close} isDisabled={!connectedComputerName}>
                      {m.computer_connect_done()}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
