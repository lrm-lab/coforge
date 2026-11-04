import { DialogAction } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import { AssistantCard } from "./onboarding-assistant-card";
import { WizardShell } from "./onboarding-wizard-frame";

/** Step 4: the assistant takes over. Its DM opens and it greets the member there, and with a role
 * known offers a starter team. */
export function OnboardingHandoffStep({
  assistant,
  roleKnown,
  starting,
  onStart,
}: {
  assistant: { agentId: string; displayName: string; avatarMascot: string | null };
  roleKnown: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <WizardShell
      step="handoff"
      title={m.onboarding_wizard_handoff_title({ name: assistant.displayName })}
      description={
        roleKnown
          ? m.onboarding_wizard_handoff_description_role()
          : m.onboarding_wizard_handoff_description()
      }
      bodyClassName="flex flex-col items-center justify-center gap-4 bg-secondary px-6 py-8"
      actions={
        <DialogAction isLoading={starting} showTextWhileLoading onPress={onStart}>
          {m.onboarding_wizard_start()}
        </DialogAction>
      }
    >
      <AssistantCard
        agentId={assistant.agentId}
        avatarMascot={assistant.avatarMascot}
        name={assistant.displayName}
      />
    </WizardShell>
  );
}
