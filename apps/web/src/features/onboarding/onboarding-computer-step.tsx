import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import { StatusDot } from "#src/components/ui/status-dot";
import { computerLabel } from "#src/features/computers/computer-identity";
import { ComputerInstallCommand } from "#src/features/computers/computer-install-command";
import { ComputerTypeOption } from "#src/features/computers/computer-type-option";
import { m } from "#src/paraglide/messages";
import { ConnectionChecks } from "./onboarding-connection-checks";
import {
  localConnectionChecks,
  type ComputerChoice,
  type computerSelection,
} from "./onboarding-wizard-plan";

/**
 * Step 1: where the assistant runs. Both kinds are always offered as cards; the cloud card shows
 * its live state and is disabled, with the reason, when the deployment has no cluster.
 */
export function OnboardingComputerStep({
  selection: { cloud, locals, arrived, selected },
  showInstall,
  onConnectAnother,
  choice,
  onChoice,
  onLocal,
  approved,
  installOrigin,
  workspaceSlug,
}: {
  /** The computers and the selected one, derived once by the wizard (`computerSelection`);
   * `arrived` is the computer that connected while this step was open. */
  selection: ReturnType<typeof computerSelection>;
  /** Whether the install command and its checks are shown (the wizard decides, as it also polls
   * for the approval only while they are). */
  showInstall: boolean;
  onConnectAnother: () => void;
  choice: ComputerChoice;
  onChoice: (choice: ComputerChoice) => void;
  onLocal: (id: string) => void;
  /** The member approved a computer's device sign-in. */
  approved: boolean;
  installOrigin: string;
  workspaceSlug: string;
}) {
  return (
    <div className="flex flex-col gap-5 px-6 py-6 sm:px-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <ComputerTypeOption
          icon={Cloud}
          label={m.computer_cloud_computer()}
          description={
            cloud
              ? m.computer_cloud_computer_description()
              : m.onboarding_wizard_cloud_unavailable()
          }
          status={
            cloud && (
              <span className="flex items-center gap-2 text-sm font-medium text-primary">
                <StatusDot tone={cloud.online ? "online" : "offline"} className="size-2" />
                {cloud.online ? m.computer_status_online() : m.onboarding_wizard_cloud_starting()}
              </span>
            )
          }
          isDisabled={!cloud}
          selected={choice === "cloud" && cloud !== undefined}
          onSelect={() => onChoice("cloud")}
        />
        <ComputerTypeOption
          icon={Monitor}
          label={m.computer_your_computer()}
          description={m.computer_your_computer_description()}
          selected={choice === "local"}
          onSelect={() => onChoice("local")}
        />
      </div>
      {choice === "local" && locals.length > 0 && (
        <div className="flex flex-col gap-3">
          <RadioGroup
            aria-label={m.computer_your_computer()}
            value={selected?.id ?? ""}
            onChange={onLocal}
            className="gap-2"
          >
            {locals.map((computer) => (
              <RadioButton
                key={computer.id}
                value={computer.id}
                className="items-center rounded-xl border border-secondary px-4 py-3"
                label={
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <span className="truncate">{computerLabel(computer)}</span>
                    <span className="flex shrink-0 items-center gap-2 text-sm text-tertiary">
                      <StatusDot tone={computer.online ? "online" : "offline"} className="size-2" />
                      {computer.online ? m.computer_status_online() : m.computer_status_offline()}
                    </span>
                  </span>
                }
              />
            ))}
          </RadioGroup>
          {!showInstall && (
            <div>
              <Button color="link-color" size="sm" onPress={onConnectAnother}>
                {m.onboarding_wizard_connect_another()}
              </Button>
            </div>
          )}
        </div>
      )}
      {choice === "local" && showInstall && (
        <div className="-mt-1 rounded-xl border border-secondary">
          <ComputerInstallCommand
            installOrigin={installOrigin}
            workspaceSlug={workspaceSlug}
            className="px-4 py-4"
            status={
              <ConnectionChecks checks={localConnectionChecks({ approved, computer: arrived })} />
            }
          />
        </div>
      )}
      {choice === "local" && !showInstall && selected && (
        <ConnectionChecks checks={localConnectionChecks({ approved: true, computer: selected })} />
      )}
    </div>
  );
}
