import {
  createContext,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Heading, Text } from "react-aria-components";
import { XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { PhoneFormBar } from "#src/components/ui/phone-form-bar";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import {
  UnsavedChangesDialog,
  useReportDirty,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import { useScrollEdges } from "#src/hooks/use-scroll-edges";
import { cx } from "#src/utils/cx";
import { AGENT_ILLUSTRATIONS } from "./agent-illustrations";

const AgentCreateGuardContext = createContext<{
  setDirty: (dirty: boolean) => void;
  requestClose: () => void;
} | null>(null);

const AgentCreatePhoneBarContext = createContext<{
  slot: HTMLElement | null;
  title: string;
} | null>(null);

export function AgentCreatePhoneBar(props: Omit<Parameters<typeof PhoneFormBar>[0], "heading">) {
  const phone = useContext(AgentCreatePhoneBarContext);
  if (!phone?.slot) return null;
  return createPortal(<PhoneFormBar heading={phone.title} {...props} />, phone.slot);
}

export function AgentCreateModal({
  open,
  onOpenChange,
  dismissable = true,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissable?: boolean;
  title: string;
  children: ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const guard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
  });
  return (
    <>
      <ModalOverlay
        isOpen={open}
        page
        className="sm:items-start sm:[--modal-pt:12vh]"
        onOpenChange={(next) => {
          if (!dismissable) return;
          if (next) onOpenChange(true);
          else guard.requestClose();
        }}
      >
        <Modal className="flex w-[calc(100vw-2rem)] max-w-100 flex-col rounded-xl max-sm:overflow-hidden">
          <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div ref={setSlot} className="shrink-0 sm:hidden" />
            <AgentCreatePhoneBarContext value={{ slot, title }}>
              <AgentCreateGuardContext value={{ setDirty, requestClose: guard.requestClose }}>
                {children}
              </AgentCreateGuardContext>
            </AgentCreatePhoneBarContext>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}

export function AgentCreateForm({
  formRef,
  onSubmit,
  intro,
  footer,
  changed = false,
  children,
}: {
  formRef?: Ref<HTMLFormElement>;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  changed?: boolean;
  intro?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { ref, start: above, end: below } = useScrollEdges("y");
  const [typed, setTyped] = useState(false);
  const setDirty = useContext(AgentCreateGuardContext)?.setDirty;
  const dirty = typed || changed;
  useReportDirty(dirty, setDirty);
  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onInput={() => setTyped(true)}
      className="flex min-h-0 flex-1 flex-col"
    >
      {intro && <div className="shrink-0">{intro}</div>}
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

export function AgentCreateIntro({
  illustration,
  title,
  description,
  onClose,
  children,
}: {
  illustration?: keyof typeof AGENT_ILLUSTRATIONS;
  title: string;
  description?: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const Illustration = illustration ? AGENT_ILLUSTRATIONS[illustration] : undefined;
  const requestClose = useContext(AgentCreateGuardContext)?.requestClose ?? onClose;
  return (
    <div className="relative px-6 pt-6 text-center max-sm:px-4 max-sm:pt-4 max-sm:text-left">
      {onClose && (
        <ButtonUtility
          type="button"
          aria-label={m.controls_close()}
          icon={X}
          size="sm"
          color="tertiary"
          onClick={requestClose}
          className="absolute top-3 right-3 max-sm:hidden"
        />
      )}
      {Illustration ? (
        <Illustration className="mx-auto h-16.5 w-26.5 max-sm:hidden" />
      ) : (
        <div className="mx-auto h-16.5 w-26.5 max-sm:hidden" />
      )}
      <Heading slot="title" className="mt-3 text-lg font-semibold text-primary max-sm:sr-only">
        {title}
      </Heading>
      {description && (
        <Text
          slot="description"
          className="mt-1 block text-sm text-balance text-tertiary max-sm:mt-0 max-sm:mb-1"
        >
          {description}
        </Text>
      )}
      {children}
    </div>
  );
}

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
  const controlSize = useDialogControlSize();
  const guarded = useContext(AgentCreateGuardContext)?.requestClose;
  const requestClose = submitting || !guarded ? onCancel : guarded;
  const row = useRef<HTMLDivElement>(null);
  return (
    <div ref={row} className="grid grid-cols-2 gap-3 px-6 pt-4 pb-6 max-sm:hidden">
      <AgentCreatePhoneBar
        submitLabel={submitLabel}
        pending={submitting}
        submitDisabled={submitDisabled}
        cancelDisabled={cancelDisabled}
        onCancel={requestClose}
        onSubmit={() => row.current?.closest("form")?.requestSubmit()}
      />
      <Button
        type="button"
        color="secondary"
        size={controlSize}
        isDisabled={cancelDisabled}
        onPress={requestClose}
      >
        {m.controls_cancel()}
      </Button>
      <Button
        type="submit"
        color="primary"
        size={controlSize}
        isDisabled={submitDisabled}
        isLoading={submitting}
        showTextWhileLoading
      >
        {submitLabel}
      </Button>
    </div>
  );
}
