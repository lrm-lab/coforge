import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { OptionCard, OptionCardGroup } from "#src/components/ui/option-card";
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
  selection: ReturnType<typeof computerSelection>;
  showInstall: boolean;
  onConnectAnother: () => void;
  choice: ComputerChoice;
  onChoice: (choice: ComputerChoice) => void;
  onLocal: (id: string) => void;
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
          <OptionCardGroup
            aria-label={m.computer_your_computer()}
            value={selected?.id ?? ""}
            onChange={onLocal}
          >
            {locals.map((computer) => (
              <OptionCard
                key={computer.id}
                value={computer.id}
                label={computerLabel(computer)}
                trailing={
                  <span className="flex items-center gap-2 text-sm text-tertiary">
                    <StatusDot tone={computer.online ? "online" : "offline"} className="size-2" />
                    {computer.online ? m.computer_status_online() : m.computer_status_offline()}
                  </span>
                }
              />
            ))}
          </OptionCardGroup>
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
