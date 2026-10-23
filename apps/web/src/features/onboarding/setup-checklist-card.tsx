import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { CheckCircle } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { Button } from "#src/components/base/buttons/button";
import { CloseButton } from "#src/components/base/buttons/close-button";
import { ProgressBar } from "#src/components/base/progress-indicators/progress-indicators";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { dismissSetupChecklist, type loadSetupChecklist } from "./setup-checklist.functions";
import { setupChecklistQuery } from "./setup-checklist-query";
import { firstIncompleteStep, type SetupStepId } from "./setup-steps";
import { useSetupStepActions } from "./use-setup-step-actions";

type Checklist = Awaited<ReturnType<typeof loadSetupChecklist>>;

const STEP_LABELS: Record<SetupStepId, () => string> = {
  assistant: () => m.onboarding_step_assistant(),
  github: () => m.onboarding_step_github(),
  agent: () => m.onboarding_step_agent(),
  task: () => m.onboarding_step_task(),
  computer: () => m.onboarding_step_computer(),
  invite: () => m.onboarding_step_invite(),
};

/**
 * The "Finish setting up" card above the sidebar's user card. Renders nothing until its steps have
 * loaded (and when they fail to), so there is never a made-up 0-of-N state. Closing it hides it
 * for this person in this Workspace, on every device. Finishing the last step in front of the person
 * shows "Setup complete" until they close it; arriving with every step done shows nothing.
 */
export function SetupChecklistCard({
  workspaceId,
  workspaceSlug,
  userId,
}: {
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
}) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const query = setupChecklistQuery(workspaceId, userId);
  const { data: checklist, refetch } = useQuery(query);
  const dismissed = checklist?.dismissed ?? false;
  const close = useMutation({
    mutationFn: () => dismissSetupChecklist(),
    onMutate: async () => {
      // A read still in flight must not bring the card back over the close.
      await queryClient.cancelQueries({ queryKey: query.queryKey });
      const previous = queryClient.getQueryData(query.queryKey);
      queryClient.setQueryData(query.queryKey, (current) =>
        current ? { ...current, dismissed: true, steps: [] } : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(query.queryKey, context?.previous);
      toast.error(m.onboarding_dismiss_failed());
    },
  });
  const allDone = checklist?.steps.every((step) => step.done);
  // A step is usually done on the page its row opens, so coming away from that page asks again.
  // Only a page change asks again; a new answer must not, so the last page asked from is kept.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const askedFrom = useRef(pathname);
  useEffect(() => {
    if (askedFrom.current === pathname) return;
    askedFrom.current = pathname;
    if (!dismissed && allDone === false) void refetch();
  }, [pathname, dismissed, allDone, refetch]);
  // Whether the first steps this card loaded were all done: then there is nothing to celebrate.
  const [initialAllDone, setInitialAllDone] = useState<boolean>();
  if (checklist && initialAllDone === undefined) setInitialAllDone(allDone);

  if (!checklist || dismissed || (allDone && initialAllDone !== false)) return null;
  return (
    <SetupChecklistPanel
      checklist={checklist}
      workspaceSlug={workspaceSlug}
      onClose={() => close.mutate()}
    />
  );
}

/** Untitled's featured card with a progress bar (`FeaturedCardProgressBar`), listing the steps. */
function SetupChecklistPanel({
  checklist,
  workspaceSlug,
  onClose,
}: {
  checklist: Checklist;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const toast = useAppToast();
  const actions = useSetupStepActions(workspaceSlug, checklist);
  const run = useMutation({
    mutationFn: (id: SetupStepId) => actions[id](),
    onError: () => toast.error(m.onboarding_step_failed()),
  });
  const total = checklist.steps.length;
  const done = checklist.steps.filter((step) => step.done).length;
  const next = firstIncompleteStep(checklist.steps);

  if (!next)
    return (
      <Shell
        state="complete"
        onClose={onClose}
        title={
          <>
            <CheckCircle aria-hidden="true" className="size-5 shrink-0 text-fg-success-primary" />
            {m.onboarding_complete()}
          </>
        }
      />
    );

  return (
    <Shell state="open" onClose={onClose} title={m.onboarding_title()}>
      <div role="group" aria-label={m.onboarding_progress_label()}>
        <ProgressBar
          value={done}
          max={total}
          labelPosition="right"
          valueFormatter={() => m.onboarding_progress_count({ done, total })}
          className="h-1.5 rounded-full"
          progressClassName="rounded-full"
        />
      </div>
      <ul className="flex flex-col">
        {checklist.steps.map((step) => (
          <li key={step.id}>
            <AriaButton
              isDisabled={run.isPending}
              onPress={() => run.mutate(step.id)}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm outline-focus-ring transition-colors duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed",
                step.done ? "text-tertiary" : "text-secondary",
              )}
            >
              {step.done ? (
                <CheckCircle
                  aria-hidden="true"
                  className="size-4 shrink-0 text-fg-success-primary"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-fg-quaternary"
                />
              )}
              <span className="min-w-0 flex-1">{STEP_LABELS[step.id]()}</span>
              <span className="sr-only">
                {step.done ? m.onboarding_step_done() : m.onboarding_step_todo()}
              </span>
            </AriaButton>
          </li>
        ))}
      </ul>
      <Button
        color="secondary"
        size="sm"
        className="w-full"
        isDisabled={run.isPending}
        onPress={() => run.mutate(next.id)}
      >
        {STEP_LABELS[next.id]()}
      </Button>
    </Shell>
  );
}

/** The card both states share: title, the close button, and the content below them. */
function Shell({
  state,
  title,
  onClose,
  children,
}: {
  state: "open" | "complete";
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-setup-checklist={state}
      className="relative flex flex-col gap-3 rounded-xl bg-secondary p-4"
    >
      <h2
        id={headingId}
        className="flex items-center gap-2 pr-6 text-sm font-semibold text-primary"
      >
        {title}
      </h2>
      {/* No slot: inside the mobile drawer's dialog the default `close` slot would close the drawer. */}
      <CloseButton
        size="sm"
        slot={null}
        label={m.onboarding_dismiss()}
        onPress={onClose}
        className="absolute top-1 right-1"
      />
      {children}
    </section>
  );
}
