import { useState } from "react";
import { Check, Edit01 as Pencil, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail-view";

export function ComputerDetailNameBand({
  computer,
  label,
  onUpdateDisplayName,
}: {
  computer: ComputerDetailView;
  label: string;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(computer.displayName);
  const [saving, setSaving] = useState(false);
  const toast = useAppToast();
  const canEdit = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);

  const cancel = () => {
    setDraft(computer.displayName);
    setEditing(false);
  };

  return (
    <section className="border-b border-secondary px-page py-4">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-tertiary">{m.computer_display_name()}</span>
        {canEdit && !editing ? (
          <ButtonUtility
            type="button"
            size="xs"
            color="tertiary"
            icon={Pencil}
            tooltip={m.computer_display_name_edit()}
            onClick={() => {
              setDraft(computer.displayName);
              setEditing(true);
            }}
          />
        ) : null}
      </div>

      {editing ? (
        <form
          className="mt-2 flex min-w-0 items-center gap-1.5"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || saving) return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!onUpdateDisplayName) return;
            setSaving(true);
            try {
              await onUpdateDisplayName(draft);
              setEditing(false);
            } catch {
              toast.error(m.computer_display_name_error());
            } finally {
              setSaving(false);
            }
          }}
        >
          <Input
            aria-label={m.computer_display_name()}
            size="sm"
            autoFocus
            isRequired
            maxLength={200}
            value={draft}
            isDisabled={saving}
            onChange={setDraft}
            className="max-w-sm min-w-0 flex-1"
          />
          <ButtonUtility
            type="submit"
            size="sm"
            color="tertiary"
            icon={Check}
            className="shrink-0"
            isDisabled={saving}
            tooltip={saving ? m.computer_display_name_saving() : m.computer_display_name_save()}
          />
          <ButtonUtility
            type="button"
            size="sm"
            color="tertiary"
            icon={XClose}
            className="shrink-0"
            isDisabled={saving}
            tooltip={m.computer_display_name_cancel()}
            onClick={cancel}
          />
        </form>
      ) : (
        <p className="mt-1.5 text-sm text-primary wrap-anywhere">{label}</p>
      )}
    </section>
  );
}
