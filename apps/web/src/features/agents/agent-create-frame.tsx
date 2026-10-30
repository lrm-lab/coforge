import { useEffect, useRef, useState, type FC, type FormEvent, type ReactNode } from "react";
import { Heading, Text } from "react-aria-components";
import { Plus, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
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

/** Art, title and one line of what the form makes, centred above it; the close button sits in the
 * card's corner. The art is a placeholder icon until the illustrations are final. */
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
  const { ref, above, below } = useScrollEdges();
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

/** Whether a scroll box has content above or below what it shows; kept current as it scrolls or
 * its content or height changes. */
function useScrollEdges() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const above = box.scrollTop > 0;
      const below = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
      setEdges((current) =>
        current.above === above && current.below === below ? current : { above, below },
      );
    };
    measure();
    box.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    for (const child of box.children) resize.observe(child);
    return () => {
      box.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, []);
  return { ref, ...edges };
}

export function AgentCreateIntro({
  icon,
  title,
  description,
  onClose,
}: {
  icon: FC<{ className?: string }>;
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
      <div aria-hidden="true" className="flex h-16.5 items-center justify-center">
        <FeaturedIcon icon={icon} color="brand" theme="light" size="xl" />
      </div>
      <Heading slot="title" className="mt-2.5 text-lg font-semibold text-primary">
        {title}
      </Heading>
      <Text slot="description" className="mt-2 block text-sm text-tertiary">
        {description}
      </Text>
    </div>
  );
}

/** Cancel and the create button side by side. */
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
  return (
    <div className="px-6 pt-5 pb-6">
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          color="secondary"
          size="lg"
          isDisabled={cancelDisabled}
          onPress={onCancel}
        >
          {m.controls_cancel()}
        </Button>
        <Button
          type="submit"
          size="lg"
          // Pending, not disabled, while it runs: focus stays on it, so Escape still reaches the dialog.
          isDisabled={submitDisabled}
          isLoading={submitting}
          showTextWhileLoading
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
