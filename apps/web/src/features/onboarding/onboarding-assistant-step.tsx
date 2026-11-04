import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { DialogAction } from "#src/components/ui/dialog-actions";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { runtimeOptionsFromRuntimes } from "#src/features/agents/agent-runtime-options";
import { getComputerRuntimeCatalog } from "#src/features/computers/computers.functions";
import {
  AgentRuntimeFields,
  type RuntimeSelection,
} from "#src/features/agents/agent-runtime-fields";
import { m } from "#src/paraglide/messages";
import { AssistantCard } from "./onboarding-assistant-card";
import { computerKind } from "#src/features/computers/computer-identity";
import { wizardErrorMessage } from "./onboarding-wizard-errors";
import { WizardShell } from "./onboarding-wizard-frame";
import { defaultRuntimeProvider, type WizardComputer } from "./onboarding-wizard-plan";

export type AssistantChoice = {
  provider: RuntimeSelection["provider"];
  model: string;
  modelProvider: string;
  reasoning: string;
  fastMode: boolean;
};

/**
 * Step 2: the assistant as a card beside the runtime and model it runs on. This configures the
 * assistant first sign-in already made; it creates nothing. "Start over" goes back to the computer.
 */
export function OnboardingAssistantStep({
  assistant,
  computer,
  onBack,
  onSave,
  skip,
}: {
  assistant: { agentId: string; displayName: string; avatarMascot: string | null };
  computer: WizardComputer;
  onBack: () => void;
  /** Saves the choice (the server refuses one the computer cannot run); rejects with the cause. */
  onSave: (choice: AssistantChoice) => Promise<void>;
  skip: ReactNode;
}) {
  const [submitting, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  // The runtimes come from the computer the step already read; only the model catalog is fetched.
  const loadOptions = useCallback(
    async (computerId: string) => ({
      ...runtimeOptionsFromRuntimes(computer.runtimes),
      catalogs: await loadCatalog({ data: { computerId } }),
    }),
    [computer.runtimes, loadCatalog],
  );
  const provider =
    defaultRuntimeProvider(
      computerKind(computer.kind),
      runtimeOptionsFromRuntimes(computer.runtimes).providers,
    ) ?? RUNTIME_PROVIDER.PI;
  const initial = useMemo<RuntimeSelection>(
    () => ({ provider, modelProvider: "", model: "", reasoning: "" }),
    [provider],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    await guard(async () => {
      try {
        await onSave({
          provider: parseRuntimeProvider(form.get("provider")) ?? provider,
          model: String(form.get("model") ?? ""),
          modelProvider: String(form.get("modelProvider") ?? ""),
          reasoning: String(form.get("reasoning") ?? ""),
          fastMode: form.get("fastMode") === "true",
        });
      } catch (cause) {
        setError(wizardErrorMessage(cause));
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <WizardShell
        step="assistant"
        title={m.onboarding_wizard_assistant_title()}
        description={m.onboarding_wizard_assistant_description()}
        bodyClassName="grid md:grid-cols-2"
        skip={
          <>
            <Button
              type="button"
              color="link-gray"
              size="sm"
              isDisabled={submitting}
              onPress={onBack}
            >
              {m.onboarding_wizard_start_over()}
            </Button>
            {skip}
          </>
        }
        actions={
          <DialogAction type="submit" isLoading={submitting} showTextWhileLoading>
            {m.controls_next()}
          </DialogAction>
        }
      >
        <div className="flex items-center justify-center bg-secondary px-6 py-8 max-md:border-b max-md:border-secondary md:border-r md:border-secondary">
          <AssistantCard
            agentId={assistant.agentId}
            avatarMascot={assistant.avatarMascot}
            name={assistant.displayName}
          />
        </div>
        <div className="flex flex-col gap-4 px-6 py-6 sm:px-8">
          <AgentRuntimeFields
            key={computer.id}
            open
            computerId={computer.id}
            initial={initial}
            onLoad={loadOptions}
          />
          {error && (
            <p role="alert" className="text-sm text-error-primary">
              {error}
            </p>
          )}
        </div>
      </WizardShell>
    </form>
  );
}
