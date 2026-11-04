import { useEffect, useRef, type ReactNode } from "react";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { DialogActions } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { WIZARD_STEPS, type WizardStep } from "./onboarding-wizard-plan";

/**
 * The setup wizard's modal, as wide as Raft's and over the real Workspace: closed by neither
 * Escape nor a click outside, since the only ways out are finishing and skipping. On a phone it
 * takes the full width.
 */
export function OnboardingWizardModal({ children }: { children: ReactNode }) {
  return (
    <ModalOverlay isOpen isDismissable={false} isKeyboardDismissDisabled className="max-sm:px-0">
      <Modal className="flex w-[calc(100vw-2rem)] max-w-[55rem] flex-col max-sm:w-full max-sm:rounded-b-none">
        <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden sm:min-h-[38rem]">
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Which of the four steps the member is on: one segment per step, filled up to the current one. */
function WizardProgress({ step }: { step: WizardStep }) {
  const current = WIZARD_STEPS.indexOf(step);
  return (
    <div role="group" aria-label={m.onboarding_progress_label()} className="flex w-28 gap-1.5">
      {WIZARD_STEPS.map((id, index) => (
        <ProgressBarBase key={id} value={index <= current ? 100 : 0} className="h-1.5" />
      ))}
    </div>
  );
}

/**
 * Three regions with a stable body height, so the steps do not change the modal's size: a header
 * (the small eyebrow, the step's progress, its title and the one line saying what it is for), the
 * body, and a footer with the quiet skip on the left and the step's actions on the right. The
 * body is a column; a step that wants its own layout passes `bodyClassName`.
 */
export function WizardShell({
  step,
  title,
  description,
  skip,
  actions,
  bodyClassName,
  children,
}: {
  step: WizardStep;
  title: string;
  description: string;
  skip?: ReactNode;
  actions: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  // Each step is a new shell: focus moves to its heading so a screen reader announces the step.
  const header = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const heading = header.current?.querySelector<HTMLElement>("h1,h2,h3,h4");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div
        ref={header}
        className="shrink-0 border-b border-secondary px-6 pt-6 pb-5 sm:px-8 sm:pt-7 [&_:is(h1,h2,h3,h4)]:outline-none"
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-brand-secondary">
            {m.onboarding_wizard_eyebrow()}
          </p>
          <WizardProgress step={step} />
        </div>
        <DialogHeader title={title} description={description} className="mt-1.5 p-0" />
      </div>
      <div className={cx("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>{children}</div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch border-t border-secondary px-6 py-4 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-4">{skip}</div>
        <DialogActions>{actions}</DialogActions>
      </div>
    </>
  );
}
