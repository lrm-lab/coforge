import type { FormEvent, ReactNode } from "react";
import { Heading, Text } from "react-aria-components";
import { XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { useScrollEdges } from "#src/hooks/use-scroll-edges";
import { cx } from "#src/utils/cx";
import { AGENT_ILLUSTRATIONS } from "./agent-illustrations";

/** The new-Agent dialog's frame: a 400px card whose forms swap inside it, so choosing the other
 * kind of Agent never closes and reopens the dialog. It hangs from near the top of the screen, not
 * centred, so a form that grows or shrinks moves only its bottom edge. A form is an
 * `AgentCreateForm`: its intro and footer stay put and only its fields scroll. */
export function AgentCreateModal({
  open,
  onOpenChange,
  dismissable = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False while a create runs: the dialog stays until it settles. */
  dismissable?: boolean;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      className="sm:items-start sm:[--modal-pt:12vh]"
      onOpenChange={(next) => {
        if (dismissable) onOpenChange(next);
      }}
    >
      <Modal className="flex w-[calc(100vw-2rem)] max-w-100 flex-col rounded-xl max-sm:overflow-hidden">
        <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** A form in the dialog: its intro and footer stay put and only its fields scroll. */
export function AgentCreateForm({
  onSubmit,
  intro,
  footer,
  children,
}: {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Absent where the dialog's head sits outside the form (the new-Agent dialog's kind cards). */
  intro?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { ref, start: above, end: below } = useScrollEdges("y");
  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      {intro && <div className="shrink-0">{intro}</div>}
      {/* A divider on each side that hides more fields, so a cut-off form reads as one that scrolls. */}
      <div
        ref={ref}
        className={cx(
          "min-h-0 flex-1 overflow-y-auto border-y border-transparent transition-colors",
          above && "border-t-secondary",
          below && "border-b-secondary",
        )}
      >
        {children}
      </div>
      <div className="shrink-0">{footer}</div>
    </form>
  );
}

/** The dialog's head, centred: the kind's illustration, the title, then a line on what this kind
 * of Agent is or, in the new-Agent dialog, the switch between kinds (`children`). */
export function AgentCreateIntro({
  illustration,
  title,
  description,
  onClose,
  children,
}: {
  illustration: keyof typeof AGENT_ILLUSTRATIONS;
  title: string;
  description?: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const Illustration = AGENT_ILLUSTRATIONS[illustration];
  return (
    <div className="relative px-6 pt-6 text-center">
      {onClose && (
        <ButtonUtility
          type="button"
          aria-label={m.controls_close()}
          icon={X}
          size="sm"
          color="tertiary"
          onClick={onClose}
          className="absolute top-3 right-3"
        />
      )}
      <Illustration className="mx-auto h-16.5 w-26.5" />
      <Heading slot="title" className="mt-3 text-lg font-semibold text-primary">
        {title}
      </Heading>
      {description && (
        <Text slot="description" className="mt-1 block text-sm text-balance text-tertiary">
          {description}
        </Text>
      )}
      {children}
    </div>
  );
}

/** Cancel and the create button side by side, each half the width. */
export function AgentCreateFooter({
  onCancel,
  cancelDisabled,
  submitLabel,
  submitting,
  submitDisabled,
}: {
  onCancel: () => void;
  cancelDisabled?: boolean;
  submitLabel: string;
  submitting: boolean;
  submitDisabled?: boolean;
}) {
  // Two equal halves, as in the design.
  return (
    <div className="grid grid-cols-2 gap-3 px-6 pt-4 pb-6">
      <Button
        type="button"
        color="secondary"
        size="md"
        isDisabled={cancelDisabled}
        onPress={onCancel}
      >
        {m.controls_cancel()}
      </Button>
      <Button
        type="submit"
        color="primary"
        size="md"
        // Pending, not disabled, while it runs: focus stays on it, so Escape still reaches the dialog.
        isDisabled={submitDisabled}
        isLoading={submitting}
        showTextWhileLoading
      >
        {submitLabel}
      </Button>
    </div>
  );
}
