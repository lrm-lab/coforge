import { useState } from "react";
import { Check, Edit01 as Pencil, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";
import { useAppToast } from "#src/components/ui/toast";
import { cn } from "#src/lib/utils";
import type { ComputerDetailView } from "./computer-detail-view";
import { operatingSystemLabel } from "./computer-identity";
import { StatusDot } from "#src/components/ui/status-dot";

/**
 * Which Computer this is, in its page's header band: its name, where it runs (its hostname, when
 * the name is another, and its system) and whether it is online; its owner renames it in place.
 * Below `sm` the band keeps the name and status, and the page shows where it runs
 * (`ComputerDetailWhere`).
 */
export function ComputerDetailTitle({
  computer,
  label,
  onUpdateDisplayName,
}: {
  computer: ComputerDetailView;
  label: string;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
}) {
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const toast = useAppToast();
  const canEditDisplayName = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);

  if (editingDisplayName) {
    const cancel = () => {
      setDisplayNameDraft(computer.displayName);
      setEditingDisplayName(false);
    };
    // The band is one line beside Restart, down to a phone's width: Save and Cancel are icons,
    // and a failed save says so in a toast rather than a line the band has no room for.
    return (
      <form
        className="flex min-w-0 items-center gap-1"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!onUpdateDisplayName) return;
          setSavingDisplayName(true);
          try {
            await onUpdateDisplayName(displayNameDraft);
            setEditingDisplayName(false);
          } catch {
            toast.error(m.computer_display_name_error());
          } finally {
            setSavingDisplayName(false);
          }
        }}
      >
        <Input
          aria-label={m.computer_display_name()}
          size="sm"
          autoFocus
          isRequired
          maxLength={200}
          value={displayNameDraft}
          isDisabled={savingDisplayName}
          onChange={setDisplayNameDraft}
          className="max-w-64 min-w-0 flex-1"
        />
        <ButtonUtility
          type="submit"
          size="sm"
          color="tertiary"
          icon={Check}
          className="shrink-0"
          isDisabled={savingDisplayName}
          tooltip={
            savingDisplayName ? m.computer_display_name_saving() : m.computer_display_name_save()
          }
        />
        <ButtonUtility
          type="button"
          size="sm"
          color="tertiary"
          icon={XClose}
          className="shrink-0"
          isDisabled={savingDisplayName}
          tooltip={m.computer_display_name_cancel()}
          onClick={cancel}
        />
      </form>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <h1 className="min-w-0 truncate text-md font-semibold text-primary">{label}</h1>
      {canEditDisplayName && (
        <ButtonUtility
          type="button"
          size="xs"
          color="tertiary"
          icon={Pencil}
          className="-ml-1 shrink-0"
          aria-label={m.computer_display_name_edit()}
          onClick={() => {
            setDisplayNameDraft(computer.displayName);
            setEditingDisplayName(true);
          }}
        />
      )}
      <ComputerDetailWhere computer={computer} label={label} className="hidden truncate sm:block" />
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-secondary px-2 py-0.5 text-xs text-secondary">
        <StatusDot tone={computer.online ? "online" : "offline"} className="size-2" />
        {computer.online ? m.computer_status_online() : m.computer_status_offline()}
      </span>
    </div>
  );
}

/** Where the Computer runs: its hostname, when its name is another, and its system. */
export function ComputerDetailWhere({
  computer,
  label,
  className,
}: {
  computer: ComputerDetailView;
  label: string;
  className?: string;
}) {
  return (
    <p className={cn("min-w-0 text-sm text-tertiary", className)}>
      {computer.name && computer.name !== label && (
        <>
          <span className="font-mono">{computer.name}</span>
          {" · "}
        </>
      )}
      {operatingSystemLabel(computer)}
    </p>
  );
}
