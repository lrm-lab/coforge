import { useRef, useState } from "react";
import { Check, Edit01 as Pencil, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail-view";

export function ComputerDetailInlineTitle({
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
  const readContainerRef = useRef<HTMLDivElement>(null);
  const toast = useAppToast();
  const canEdit = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);

  const closeAndRefocus = () => {
    setEditing(false);
    queueMicrotask(() => {
      readContainerRef.current
        ?.querySelector<HTMLButtonElement>("[data-edit-computer-name]")
        ?.focus();
    });
  };

  const cancel = () => {
    setDraft(computer.displayName);
    closeAndRefocus();
  };

  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || saving) return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (!onUpdateDisplayName || !trimmed) return;
          setSaving(true);
          try {
            await onUpdateDisplayName(trimmed);
            closeAndRefocus();
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
          className="min-w-0 flex-1"
        />
        <ButtonUtility
          type="submit"
          size="xs"
          color="tertiary"
          icon={Check}
          className="shrink-0"
          isDisabled={saving || !draft.trim()}
          tooltip={saving ? m.computer_display_name_saving() : m.computer_display_name_save()}
        />
        <ButtonUtility
          type="button"
          size="xs"
          color="tertiary"
          icon={XClose}
          className="shrink-0"
          isDisabled={saving}
          tooltip={m.computer_display_name_cancel()}
          onClick={cancel}
        />
      </form>
    );
  }

  return (
    <div ref={readContainerRef} className="flex min-w-0 flex-1 items-center gap-1">
      <h1 dir="auto" className="min-w-0 truncate text-sm font-semibold text-primary">
        <Tooltip title={label}>
          <TooltipTrigger className="block max-w-full min-w-0 truncate rounded-xs text-start outline-focus-ring focus-visible:outline-2">
            {label}
          </TooltipTrigger>
        </Tooltip>
      </h1>
      {canEdit ? (
        <ButtonUtility
          type="button"
          size="xs"
          color="tertiary"
          icon={Pencil}
          data-edit-computer-name=""
          className="shrink-0"
          tooltip={m.computer_display_name_edit()}
          onClick={() => {
            setDraft(computer.displayName);
            setEditing(true);
          }}
        />
      ) : null}
    </div>
  );
}
