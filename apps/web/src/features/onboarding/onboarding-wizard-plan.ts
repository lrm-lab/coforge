import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

import type { ProgressStepStatus } from "#src/components/ui/progress-steps";
import { runtimeOptionsFromRuntimes } from "#src/features/agents/agent-runtime-options";
import { RUNTIME_PROVIDER_DISPLAY_ORDER } from "#src/features/agents/runtime-provider-display";
import { computerLabel } from "#src/features/computers/computer-identity";
import type { loadOnboardingComputers } from "./onboarding-wizard.functions";

/** The setup wizard's steps, in order. */
export const WIZARD_STEPS = ["computer", "assistant", "role", "handoff"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** A computer as the connect step reads it (`OnboardingWizard.computers`). */
export type WizardComputer = Awaited<ReturnType<typeof loadOnboardingComputers>>[number];

export type ComputerChoice = "cloud" | "local";

/** The member's own default cloud computer; a deployment without a cloud cluster has none. */
export function wizardCloudComputer<T extends WizardComputer>(computers: readonly T[]) {
  return computers.find(
    (computer) =>
      computer.kind === "cloud" && computer.cloudSlot === "default" && computer.ownedByCurrentUser,
  );
}

/** The local computers the member owns, oldest first as listed. */
export function wizardLocalComputers<T extends WizardComputer>(computers: readonly T[]) {
  return computers.filter((computer) => computer.kind === "local" && computer.ownedByCurrentUser);
}

/** A member who already owns a local computer starts on it; otherwise the cloud one, when the
 * deployment has it. */
export function initialComputerChoice(computers: readonly WizardComputer[]): ComputerChoice {
  if (wizardLocalComputers(computers).length > 0) return "local";
  return wizardCloudComputer(computers) ? "cloud" : "local";
}

/** The runtimes the computer reports as usable. */
function usableProviders(computer: WizardComputer | undefined): RuntimeProvider[] {
  return runtimeOptionsFromRuntimes(computer?.runtimes ?? []).providers;
}

/**
 * What the connect step shows and what the assistant is bound to, derived once for both. The
 * selected local computer is the one the member picked, else the one that connected while the step
 * was open (`knownIds` are the computers they had at the start), else the first usable one, else
 * the first.
 */
export function computerSelection(input: {
  computers: readonly WizardComputer[];
  choice: ComputerChoice;
  pickedLocalId: string | undefined;
  knownIds: ReadonlySet<string>;
}) {
  const { computers, choice, pickedLocalId, knownIds } = input;
  const cloud = wizardCloudComputer(computers);
  const locals = wizardLocalComputers(computers);
  const arrived = locals.find((computer) => computer.online && !knownIds.has(computer.id));
  const local =
    locals.find((computer) => computer.id === pickedLocalId) ??
    arrived ??
    locals.find((computer) => canLeaveComputerStep("local", computer)) ??
    locals[0];
  return { cloud, locals, arrived, selected: choice === "cloud" ? cloud : local };
}

/**
 * Whether the first step can go on with `chosen`. The cloud computer only has to exist: it starts
 * by itself and Pi needs no detection. A local computer has to be connected, with a runtime
 * detected that the assistant can use.
 */
export function canLeaveComputerStep(
  choice: ComputerChoice,
  chosen: WizardComputer | undefined,
): boolean {
  if (!chosen) return false;
  if (choice === "cloud") return true;
  return chosen.online && defaultRuntimeProvider("local", usableProviders(chosen)) !== undefined;
}

/** Best first: Pi is the assistant's own default, then Claude Code, then the runtime picker's own
 * order, so a provider added later is considered without being listed here. CoForge's runtime
 * needs an API key and is not in that order, so it is never chosen for the member. */
const RUNTIME_PREFERENCE: readonly RuntimeProvider[] = [
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.CLAUDE_CODE,
  ...RUNTIME_PROVIDER_DISPLAY_ORDER.filter(
    (provider) => provider !== RUNTIME_PROVIDER.PI && provider !== RUNTIME_PROVIDER.CLAUDE_CODE,
  ),
];

/** The runtime the assistant step starts on: Pi on the cloud computer, the best detected one on a
 * local computer (none when nothing usable was detected). */
export function defaultRuntimeProvider(
  choice: ComputerChoice,
  detected: readonly RuntimeProvider[],
): RuntimeProvider | undefined {
  if (choice === "cloud") return RUNTIME_PROVIDER.PI;
  return RUNTIME_PREFERENCE.find((provider) => detected.includes(provider));
}

/** One line of the live check list while a local computer connects. */
export type ConnectionCheck =
  | { id: "approved"; status: ProgressStepStatus }
  | { id: "connected"; status: ProgressStepStatus; name?: string }
  | { id: "runtime"; status: ProgressStepStatus; providers: RuntimeProvider[] };

/**
 * Raft's list for a local computer being connected: request approved, the machine connected, a
 * runtime detected. The first line not yet done is `current`, the ones after it `incomplete`. A
 * computer that is up proves its request was approved.
 */
export function localConnectionChecks(input: {
  approved: boolean;
  computer: WizardComputer | undefined;
}): ConnectionCheck[] {
  const connected = input.computer?.online === true;
  const providers = connected ? usableProviders(input.computer) : [];
  const done = [input.approved || connected, connected, providers.length > 0];
  const current = done.indexOf(false);
  const status = (index: number): ProgressStepStatus =>
    done[index] ? "complete" : index === current ? "current" : "incomplete";
  return [
    { id: "approved", status: status(0) },
    {
      id: "connected",
      status: status(1),
      name: connected && input.computer ? computerLabel(input.computer) : undefined,
    },
    { id: "runtime", status: status(2), providers },
  ];
}
