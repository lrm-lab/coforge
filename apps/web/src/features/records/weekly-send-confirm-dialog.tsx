import { AlertCircle, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { m } from "#src/paraglide/messages";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";

export const WEEKLY_SEND_TOAST_MS = 3000;

export function WeeklySendConfirmDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (busy) return;
        onOpenChange(value);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={X}
                size="sm"
                color="tertiary"
                isDisabled={busy}
                className="absolute top-4 right-4"
                onClick={close}
              />
              <div className="flex items-start gap-3 pr-8">
                <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
                <div className="min-w-0 space-y-2">
                  <Heading slot="title" className="text-md font-semibold text-primary">
                    {m.records_report_confirm_send_title()}
                  </Heading>
                  <Text slot="description" className="text-sm text-secondary">
                    {m.records_report_confirm_send_body()}
                  </Text>
                </div>
              </div>
              <DialogActions className="mt-6">
                <DialogCancel type="button" isDisabled={busy} onPress={close}>
                  {m.records_template_cancel()}
                </DialogCancel>
                <DialogAction
                  type="button"
                  className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                  isDisabled={busy}
                  onPress={() => void onConfirm()}
                >
                  {m.records_report_send()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
