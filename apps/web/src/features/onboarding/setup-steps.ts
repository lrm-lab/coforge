/** The steps of the Workspace sidebar's setup checklist, in the order the card lists them. */
export const SETUP_STEP_IDS = ["github", "agent", "computer"] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export type SetupStep = { id: SetupStepId; done: boolean };

/** The first step still to do: what the card's bottom button runs. */
export function firstIncompleteStep(steps: readonly SetupStep[]): SetupStep | undefined {
  return steps.find((step) => !step.done);
}
