import { useState } from "react";

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
      <Button type="button" size="sm" color="secondary-destructive" onPress={() => setOpen(true)}>
        {m.computer_remove_action()}
      </Button>
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
