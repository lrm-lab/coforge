import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal } from "@untitledui/icons";
import { useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isAppError } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { LabelColorPicker } from "./label-color-picker";
import {
  LABEL_DESCRIPTION_MAX,
  LABEL_NAME_MAX_LENGTH,
  nameTaken,
  type SettingsLabel,
} from "./label-settings-model";
import { deleteTaskLabel, updateTaskLabel } from "./labels.functions";
import { LabelDot } from "./task-label-chip";

/** What a row is editing in place. */
type Editing = "rename" | "description" | null;

/** A permanent delete refused because the label is no longer archived (restored elsewhere). */
const notArchived = (cause: unknown) =>
  isAppError(cause) && cause.errorId === "task-label-not-archived";

/** Why a change was refused, as the row says it. */
function changeError(cause: unknown, name: string) {
  if (isAppError(cause) && cause.errorId === "task-label-name-taken")
    return m.labels_settings_name_taken({ name });
  if (isAppError(cause) && cause.code === "ACCESS_DENIED") return m.labels_settings_denied();
  return m.labels_settings_save_failed();
}

/**
 * One label in Settings → Labels (task #508; Frank, 11-05: after Linear, "Edit label name or color
 * by clicking on those properties in a label row", https://linear.app/docs/labels): one line of
 * its color, name and what it is for, how many Tasks carry it and when it was last put on one.
 * For an owner or admin the color opens its swatches and the name turns into a field; the menu,
 * shown on hover or focus, edits what it is for, archives, restores and (once archived) deletes
 * it for good. Every change is the server's to allow; `onChanged` reads the list again.
 */
export function LabelSettingsRow({
  label,
  labels,
  canManage,
  onChanged,
}: {
  label: SettingsLabel;
  /** Every label, for the name-taken check before a rename is sent. */
  labels: readonly SettingsLabel[];
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const update = useServerFn(updateTaskLabel);
  const remove = useServerFn(deleteTaskLabel);
  const timeZone = useTimeZone();
  const nameButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  // The delete was refused as no longer archived: read the list again when its dialog closes.
  // Not at once, as the row then moves out of the archived list and the refusal with it.
  const restoredMeanwhile = useRef(false);
  const archived = Boolean(label.archivedAt);

  /** Closes the field and hands focus back to the name it edited, not to the page. */
  function close() {
    const was = editing;
    setEditing(null);
    setError(null);
    if (was) requestAnimationFrame(() => nameButton.current?.focus());
  }

  async function save(change: {
    name?: string;
    color?: string;
    description?: string | null;
    archived?: boolean;
  }) {
    setSaving(true);
    setError(null);
    try {
      // The color is one of the palette's, which the server's enum also holds.
      await update({ data: { id: label.id, ...change, color: change.color as never } });
      await onChanged();
      close();
    } catch (cause) {
      setError(changeError(cause, change.name ?? label.name));
    } finally {
      setSaving(false);
    }
  }

  function rename() {
    const name = draft.trim();
    if (!name || name === label.name) return close();
    if (nameTaken(labels, name, label.id)) return setError(m.labels_settings_name_taken({ name }));
    void save({ name });
  }

  const saveColor = (color: string) => color !== label.color && void save({ color });

  const start = (what: Exclude<Editing, null>) => {
    setError(null);
    setDraft(what === "rename" ? label.name : (label.description ?? ""));
    setEditing(what);
  };

  const editable = canManage && !archived;
  const field = (what: Exclude<Editing, null>) => {
    const commit = () =>
      what === "rename" ? rename() : void save({ description: draft.trim() || null });
    return (
      // The refusal is the field's error message, which a screen reader hears with it. Enter or
      // leaving the field saves it; Escape puts it back.
      <Input
        aria-label={
          what === "rename"
            ? m.labels_settings_rename_field({ name: label.name })
            : m.labels_settings_description_field({ name: label.name })
        }
        placeholder={what === "description" ? m.labels_settings_description_placeholder() : ""}
        size="sm"
        value={draft}
        maxLength={what === "rename" ? LABEL_NAME_MAX_LENGTH : LABEL_DESCRIPTION_MAX}
        autoFocus
        isDisabled={saving}
        isInvalid={error !== null}
        hint={error ?? undefined}
        onChange={(next) => {
          setDraft(next);
          setError(null);
        }}
        onBlur={() => !saving && error === null && commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") close();
        }}
        wrapperClassName="min-w-0 flex-1"
      />
    );
  };

  return (
    <li
      data-label-row={label.name}
      className="group flex flex-col gap-1 px-3 py-2 hover:bg-primary_hover sm:px-4"
      aria-label={label.name}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        {editable ? (
          <LabelColorPicker
            color={label.color}
            name={label.name}
            onPick={saveColor}
            isDisabled={saving}
          />
        ) : (
          <span className="grid size-6 shrink-0 place-items-center">
            <LabelDot color={label.color} className="size-2.5" />
          </span>
        )}
        {editing === "rename" ? (
          field("rename")
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            {editable ? (
              <AriaButton
                ref={nameButton}
                aria-label={m.labels_settings_rename({ name: label.name })}
                onPress={() => start("rename")}
                className="-mx-1.5 min-w-0 shrink cursor-text truncate rounded-md px-1.5 py-0.5 text-left text-sm font-medium text-primary outline-focus-ring hover:bg-secondary focus-visible:outline-2"
              >
                {label.name}
              </AriaButton>
            ) : (
              <span
                className={cn(
                  "min-w-0 shrink truncate text-sm",
                  archived ? "text-tertiary" : "font-medium text-primary",
                )}
              >
                {label.name}
              </span>
            )}
            {editing === "description"
              ? field("description")
              : label.description && (
                  <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                    {label.description}
                  </span>
                )}
          </div>
        )}
        {/* How many of them are not finished, on hover or focus. */}
        <Tooltip title={m.labels_settings_open_count({ count: label.openCount })}>
          <TooltipTrigger className="h-auto w-20 shrink-0 rounded-sm text-right text-sm text-tertiary tabular-nums outline-focus-ring focus-visible:outline-2">
            {m.labels_settings_task_count({ count: label.taskCount })}
          </TooltipTrigger>
        </Tooltip>
        <span className="hidden w-28 shrink-0 text-right text-sm text-tertiary sm:block">
          {label.lastUsedAt
            ? formatCalendarDate(label.lastUsedAt, timeZone, getLocale())
            : m.labels_settings_never_used()}
        </span>
        {canManage ? (
          <Dropdown.Root>
            <ButtonUtility
              tooltip={m.labels_settings_actions({ name: label.name })}
              icon={DotsHorizontal}
              size="sm"
              color="tertiary"
              // Shown with the row's hover or focus where there is a pointer; always on touch.
              className="pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 data-pressed:opacity-100"
            />
            <Dropdown.Popover placement="bottom end" className="w-56">
              <Dropdown.Menu
                aria-label={m.labels_settings_actions({ name: label.name })}
                onAction={(key) => {
                  if (key === "description") start("description");
                  else if (key === "restore") void save({ archived: false });
                  else if (key === "archive" || key === "delete") setConfirming(key);
                }}
              >
                {archived
                  ? [
                      <Dropdown.Item
                        key="restore"
                        id="restore"
                        label={m.labels_settings_restore()}
                      />,
                      <Dropdown.Item key="delete" id="delete" label={m.labels_settings_delete()} />,
                    ]
                  : [
                      <Dropdown.Item
                        key="description"
                        id="description"
                        label={m.labels_settings_describe()}
                      />,
                      <Dropdown.Item
                        key="archive"
                        id="archive"
                        label={m.labels_settings_archive()}
                      />,
                    ]}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        ) : (
          // The column lines up with the managers' menu.
          <span aria-hidden="true" className="w-9 shrink-0" />
        )}
      </div>

      {/* A refused color, restore or other change; the fields show their own. */}
      {error && editing === null && (
        <p role="alert" className="pl-8 text-sm text-error-primary">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirming === "archive"}
        onOpenChange={(open) => !open && setConfirming(null)}
        // Archiving can be undone: the primary button, not the red one.
        tone="default"
        title={m.labels_settings_archive_title({ name: label.name })}
        description={
          label.taskCount === 0
            ? m.labels_settings_archive_body_unused()
            : m.labels_settings_archive_body({ count: label.taskCount })
        }
        confirmLabel={m.labels_settings_archive()}
        errorMessage={(cause) => changeError(cause, label.name)}
        onConfirm={async () => {
          await update({ data: { id: label.id, archived: true } });
          await onChanged();
          setConfirming(null);
        }}
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => {
          if (open) return;
          setConfirming(null);
          // Someone restored it meanwhile: the list shows it live again once the refusal is read.
          if (restoredMeanwhile.current) {
            restoredMeanwhile.current = false;
            void onChanged().catch(() => {});
          }
        }}
        title={m.labels_settings_delete_title({ name: label.name })}
        description={m.labels_settings_delete_body({ count: label.taskCount })}
        confirmLabel={m.labels_settings_delete()}
        errorMessage={(cause) =>
          notArchived(cause)
            ? m.labels_settings_restored_meanwhile()
            : changeError(cause, label.name)
        }
        onConfirm={async () => {
          try {
            await remove({ data: { id: label.id } });
          } catch (cause) {
            if (notArchived(cause)) restoredMeanwhile.current = true;
            throw cause;
          }
          await onChanged();
          setConfirming(null);
        }}
      />
    </li>
  );
}
