import { Suspense, lazy, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHydrated, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { isAppError } from "#src/lib/app-error";

import { Button } from "#src/components/base/buttons/button";
import { DialogAction } from "#src/components/ui/dialog-actions";
import { useAppToast } from "#src/components/ui/toast";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { m } from "#src/paraglide/messages";
import type { AssistantChoice } from "./onboarding-assistant-step";
import { OnboardingComputerStep } from "./onboarding-computer-step";
import { OnboardingHandoffStep } from "./onboarding-handoff-step";
import { OnboardingRoleStep } from "./onboarding-role-step";
import { ONBOARDING_NOT_PENDING, wizardErrorMessage } from "./onboarding-wizard-errors";
import { OnboardingWizardModal, WizardShell } from "./onboarding-wizard-frame";
import {
  canLeaveComputerStep,
  computerSelection,
  initialComputerChoice,
  type ComputerChoice,
  type WizardComputer,
  type WizardStep,
} from "./onboarding-wizard-plan";
import {
  completeOnboardingWizard,
  configureOnboardingAssistant,
  loadDeviceApproval,
  loadOnboardingComputers,
  type loadOnboardingWizard,
} from "./onboarding-wizard.functions";
import type { PersonRole } from "./person-role";

// The runtime pickers are the heavy part of the wizard and only step 2 needs them: its chunk loads
// once the first step is up, so the modal opens without waiting on it.
const loadAssistantStep = () => import("./onboarding-assistant-step");
const OnboardingAssistantStep = lazy(() =>
  loadAssistantStep().then((module) => ({ default: module.OnboardingAssistantStep })),
);

/** How often the first step re-reads the member's computers while it waits for one to connect. */
const COMPUTER_POLL_MS = 2500;

/** What the Workspace route's loader hands the wizard: the assistant it configures and the
 * member's computers. */
export type OnboardingWizardInitial = NonNullable<Awaited<ReturnType<typeof loadOnboardingWizard>>>;

/**
 * The first-sign-in setup wizard, a modal over the Workspace while the member's
 * `onboardingPendingSince` is set (`docs/design/onboarding-wizard.md`). Everything its first paint
 * needs arrives with the page (`initial`).
 */
export function OnboardingWizard({
  workspaceId,
  workspaceSlug,
  initial,
}: {
  workspaceId: string;
  workspaceSlug: string;
  initial: OnboardingWizardInitial;
}) {
  const hydrated = useHydrated();
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useAppToast();
  const loadComputers = useServerFn(loadOnboardingComputers);
  const loadApproval = useServerFn(loadDeviceApproval);
  const configure = useServerFn(configureOnboardingAssistant);
  const complete = useServerFn(completeOnboardingWizard);
  const [step, setStep] = useState<WizardStep>("computer");
  // The choice the member starts on is fixed when the wizard opens: a computer appearing later
  // (a cloud row, a freshly connected one) is shown but never moves the selection under them.
  const [initialChoice] = useState(() => initialComputerChoice(initial.computers));
  const [choice, setChoice] = useState<ComputerChoice>();
  const [connecting, setConnecting] = useState(false);
  const [localId, setLocalId] = useState<string>();
  const [role, setRole] = useState<PersonRole>();
  // The computers the member had when the wizard opened: one that connects after is the one the
  // install command was run on.
  const [knownIds] = useState<ReadonlySet<string>>(
    () => new Set(initial.computers.map((computer) => computer.id)),
  );
  const [finished, setFinished] = useState(false);
  const [finishing, guard] = useSubmitGuard();

  function selectionOf(rows: readonly WizardComputer[]) {
    const current = choice ?? initialChoice;
    return {
      current,
      ...computerSelection({ computers: rows, choice: current, pickedLocalId: localId, knownIds }),
    };
  }
  // Whether the first step waits on something that can still change: the chosen cloud computer
  // coming up, or a local computer to connect and show a runtime.
  function isWaiting({ current, cloud, selected }: ReturnType<typeof selectionOf>) {
    return current === "cloud"
      ? cloud !== undefined && !cloud.online
      : !canLeaveComputerStep("local", selected);
  }

  // Read again only while the first step is waiting; `staleTime` keeps the loader's data from
  // being read once more at mount or on focus, and later steps never read it.
  const computersQuery = useQuery({
    queryKey: ["onboarding-wizard", workspaceId, "computers"],
    queryFn: () => loadComputers(),
    initialData: initial.computers,
    staleTime: COMPUTER_POLL_MS,
    enabled: step === "computer",
    refetchInterval: (query) =>
      query.state.data && isWaiting(selectionOf(query.state.data)) ? COMPUTER_POLL_MS : false,
  });
  const selection = selectionOf(computersQuery.data);
  const { current: currentChoice, arrived, locals, selected } = selection;
  // The install command and its live checks show for a member with nothing to select, one who
  // asked to connect another, and one whose computer just arrived.
  const showInstall =
    currentChoice === "local" && (locals.length === 0 || connecting || arrived !== undefined);
  // Whether the member has approved a computer's sign-in: asked while a local computer is awaited,
  // until the answer is yes.
  const approval = useQuery({
    queryKey: ["onboarding-wizard", workspaceId, "approval"],
    queryFn: () => loadApproval(),
    enabled: step === "computer" && showInstall && !arrived,
    refetchInterval: (query) => (query.state.data?.approved ? false : COMPUTER_POLL_MS),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (hydrated) void loadAssistantStep();
  }, [hydrated]);

  if (finished || !hydrated) return null;
  const { assistant } = initial;

  const skip = (
    <Button
      type="button"
      color="link-gray"
      size="sm"
      isDisabled={finishing}
      onPress={() => void finish(undefined)}
    >
      {m.onboarding_wizard_skip()}
    </Button>
  );

  async function finish(chosen: PersonRole | undefined) {
    await guard(async () => {
      try {
        const { conversationId } = await complete({ data: { role: chosen } });
        setFinished(true);
        // The chat route remembers the DM as the Workspace's last conversation once it shows it.
        await navigate(conversationRoute({ dmId: conversationId }, workspaceSlug));
        await router.invalidate({ sync: true });
      } catch (cause) {
        toast.error(wizardErrorMessage(cause));
      }
    });
  }

  async function saveAssistant(picked: AssistantChoice) {
    if (!selected) return;
    try {
      await configure({ data: { computerId: selected.id, ...picked } });
    } catch (cause) {
      // Setup was finished elsewhere (another tab): the wizard has nothing left to do here.
      if (isAppError(cause) && cause.errorId === ONBOARDING_NOT_PENDING)
        await router.invalidate({ sync: true });
      throw cause;
    }
    setStep("role");
  }

  return (
    <OnboardingWizardModal>
      {step === "computer" && (
        <WizardShell
          step="computer"
          title={m.onboarding_wizard_computer_title()}
          description={m.onboarding_wizard_computer_description()}
          skip={skip}
          actions={
            <DialogAction
              isDisabled={!canLeaveComputerStep(currentChoice, selected)}
              onPress={() => setStep("assistant")}
            >
              {m.controls_next()}
            </DialogAction>
          }
        >
          <OnboardingComputerStep
            selection={selection}
            showInstall={showInstall}
            onConnectAnother={() => setConnecting(true)}
            choice={currentChoice}
            onChoice={setChoice}
            onLocal={setLocalId}
            approved={approval.data?.approved === true}
            installOrigin={window.location.origin}
            workspaceSlug={workspaceSlug}
          />
        </WizardShell>
      )}
      {step === "assistant" && selected && (
        <Suspense fallback={null}>
          <OnboardingAssistantStep
            assistant={assistant}
            computer={selected}
            onBack={() => setStep("computer")}
            onSave={saveAssistant}
            skip={skip}
          />
        </Suspense>
      )}
      {step === "role" && (
        <OnboardingRoleStep
          role={role}
          onRole={setRole}
          onNext={(picked) => {
            setRole(picked);
            setStep("handoff");
          }}
          skip={skip}
        />
      )}
      {step === "handoff" && (
        <OnboardingHandoffStep
          assistant={assistant}
          roleKnown={role !== undefined}
          starting={finishing}
          onStart={() => void finish(role)}
        />
      )}
    </OnboardingWizardModal>
  );
}
