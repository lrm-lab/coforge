import type { FormEvent, ReactNode } from "react";
import { Heading, Text } from "react-aria-components";
import { Plus, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { useScrollEdges } from "#src/hooks/use-scroll-edges";
import { cx } from "#src/utils/cx";

/** The new-Agent dialog's frame (Figma 3745:7147): a 400px card whose cloud and local forms swap
 * inside it, so switching between them never closes and reopens the dialog. A form is an
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
  switchTo,
  children,
}: {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  intro: ReactNode;
  footer: ReactNode;
  /** The link to the other kind of Agent, after the last field. */
  switchTo?: { label: string; onPress: () => void; isDisabled?: boolean };
  children: ReactNode;
}) {
  const { ref, start: above, end: below } = useScrollEdges("y");
  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0">{intro}</div>
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
        {switchTo && (
          <div className="px-6 pt-1 pb-3">
            <Button
              type="button"
              color="link-color"
              size="sm"
              iconLeading={Plus}
              isDisabled={switchTo.isDisabled}
              onPress={switchTo.onPress}
            >
              {switchTo.label}
            </Button>
          </div>
        )}
      </div>
      <div className="shrink-0">{footer}</div>
    </form>
  );
}

/** The dialog's title on one line with the close button at its end, and a line under it only
 * where the form needs one said before its fields (no Computer to create on yet). */
/** The dialog's two illustrations, one per kind of Agent (design: 智能体插图). */
const ILLUSTRATIONS = {
  local: "/illustrations/agent-local.webp",
  cloud: "/illustrations/agent-cloud.webp",
} as const;

/** The form's head, centred as in the design: its illustration, title and one line on what this
 * kind of Agent is. */
export function AgentCreateIntro({
  illustration,
  title,
  description,
  onClose,
}: {
  illustration: keyof typeof ILLUSTRATIONS;
  title: string;
  description: string;
  onClose?: () => void;
}) {
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
      <img
        src={ILLUSTRATIONS[illustration]}
        alt=""
        width={106}
        height={66}
        className="mx-auto block h-16.5 w-26.5"
      />
      <Heading slot="title" className="mt-3 text-lg font-semibold text-primary">
        {title}
      </Heading>
      <Text slot="description" className="mt-1 block text-sm text-balance text-tertiary">
        {description}
      </Text>
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
