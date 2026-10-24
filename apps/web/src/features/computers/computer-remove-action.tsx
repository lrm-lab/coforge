import { useState } from "react";
import { XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";

export function ComputerRemoveAction({
  name,
  onConfirm,
}: {
  name: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-4 border-t border-secondary pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-primary">{m.computer_remove_action()}</h2>
          <p className="mt-1 text-sm text-tertiary">{m.computer_remove_description()}</p>
        </div>
        <Button
          type="button"
          size="sm"
          color="secondary-destructive"
          iconLeading={X}
          className="shrink-0 self-start sm:self-auto"
          onPress={() => setOpen(true)}
        >
          {m.computer_remove_action()}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={m.computer_remove_dialog_title({ name })}
        description={m.computer_remove_description()}
        confirmLabel={m.computer_remove_action()}
        errorMessage={m.computer_remove_error()}
        onConfirm={onConfirm}
      />
    </>
  );
}
