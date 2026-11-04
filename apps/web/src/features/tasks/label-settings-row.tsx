import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal } from "@untitledui/icons";
import { useRef, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isAppError } from "#src/lib/app-error";
import { formatCalendarDate } from "#src/lib/dates";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { LabelColorSwatches } from "./label-color-swatches";
import {
  LABEL_DESCRIPTION_MAX,
  LABEL_NAME_MAX_LENGTH,
  nameTaken,
  type SettingsLabel,
} from "./label-settings-model";
import { deleteTaskLabel, updateTaskLabel } from "./labels.functions";
import { LabelDot } from "./task-label-chip";

/** What a row is doing besides showing the label. */
type Editing = "rename" | "color" | "description" | null;

/** Why a change was refused, as the row says it. */
function changeError(cause: unknown, name: string) {
  if (isAppError(cause) && cause.errorId === "task-label-name-taken")
    return m.labels_settings_name_taken({ name });
  if (isAppError(cause) && cause.code === "ACCESS_DENIED") return m.labels_settings_denied();
  return m.labels_settings_save_failed();
}

/**
 * One label in Settings → Labels (task #508): its color, name and what it is for, how many Tasks
 * carry it and when it was last put on one, and, for an owner or admin, a menu to rename,
 * recolor, describe, archive, restore and (once archived) delete it for good. Every change is
 * the server's to allow; `onChanged` reads the list again. Closing an editor puts focus back on
 * the row's menu button.
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
  const menuButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  // The color the swatches have selected: the arrow keys move it, Enter or Space saves it.
  const [colorDraft, setColorDraft] = useState(label.color);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const archived = Boolean(label.archivedAt);

  /** Closes the editor and hands focus back to the row's menu button, not to the page. */
  function close() {
    setEditing(null);
    setError(null);
    requestAnimationFrame(() => menuButton.current?.focus());
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

  const saveColor = (color: string) => (color === label.color ? close() : void save({ color }));

  const start = (what: Exclude<Editing, null>) => {
    setError(null);
    setDraft(
      what === "rename" ? label.name : what === "description" ? (label.description ?? "") : "",
    );
    setColorDraft(label.color);
    setEditing(what);
  };

  return (
    <li
      data-label-row={label.name}
      className="flex flex-col gap-2 px-4 py-3 sm:px-5"
      aria-label={label.name}
    >
      <div className="flex min-w-0 items-center gap-3">
        <LabelDot color={label.color} />
        <div className="min-w-0 flex-1">
          {editing === "rename" ? (
            // The refusal is the field's error message, which a screen reader hears with it.
            <Input
              aria-label={m.labels_settings_rename_field({ name: label.name })}
              size="sm"
              value={draft}
              maxLength={LABEL_NAME_MAX_LENGTH}
              autoFocus
              isDisabled={saving}
              isInvalid={error !== null}
              hint={error ?? undefined}
              onChange={(next) => {
                setDraft(next);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") rename();
                if (event.key === "Escape") close();
              }}
            />
          ) : (
            <p
              className={
                archived
                  ? "truncate text-sm text-tertiary"
                  : "truncate text-sm font-medium text-primary"
              }
            >
              {label.name}
            </p>
          )}
          {editing !== "rename" && label.description && editing !== "description" && (
            <p className="truncate text-xs text-tertiary">{label.description}</p>
          )}
        </div>
        {/* How many of them are not finished, on hover or focus. */}
        <Tooltip title={m.labels_settings_open_count({ count: label.openCount })}>
          <TooltipTrigger className="h-auto w-auto shrink-0 rounded-sm text-sm text-secondary tabular-nums outline-focus-ring focus-visible:outline-2">
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
              ref={menuButton}
              tooltip={m.labels_settings_actions({ name: label.name })}
              icon={DotsHorizontal}
              size="sm"
              color="tertiary"
            />
            <Dropdown.Popover placement="bottom end" className="w-56">
              <Dropdown.Menu
                aria-label={m.labels_settings_actions({ name: label.name })}
                onAction={(key) => {
                  if (key === "rename" || key === "color" || key === "description") start(key);
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
                      <Dropdown.Item key="rename" id="rename" label={m.labels_settings_rename()} />,
                      <Dropdown.Item key="color" id="color" label={m.labels_settings_color()} />,
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

      {editing === "color" && (
        // A click or tap on a swatch saves it; with the keyboard, the arrows move the pick and
        // Enter or Space saves it. Done closes the swatches unchanged.
        <div
          className="flex w-fit flex-col gap-2 pl-6"
          onKeyDownCapture={(event) => {
            if (event.key === " ") {
              // Space on the swatch already picked changes nothing a radio hears: save it here.
              event.preventDefault();
              saveColor(colorDraft);
            }
            if (event.key === "Escape") close();
          }}
        >
          <LabelColorSwatches
            value={colorDraft}
            onChange={setColorDraft}
            onPick={saveColor}
            onSubmit={() => saveColor(colorDraft)}
            isDisabled={saving}
          />
          <div>
            <Button color="tertiary" size="sm" onPress={close}>
              {m.labels_settings_done()}
            </Button>
          </div>
        </div>
      )}

      {editing === "description" && (
        <div className="flex flex-col gap-2 pl-6 sm:flex-row sm:items-center">
          <Input
            aria-label={m.labels_settings_description_field({ name: label.name })}
            size="sm"
            value={draft}
            maxLength={LABEL_DESCRIPTION_MAX}
            placeholder={m.labels_settings_description_placeholder()}
            autoFocus
            isDisabled={saving}
            isInvalid={error !== null}
            hint={error ?? undefined}
            onChange={setDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save({ description: draft.trim() || null });
              if (event.key === "Escape") close();
            }}
            wrapperClassName="flex-1"
          />
          <div className="flex gap-2">
            <Button color="tertiary" size="sm" onPress={close}>
              {m.labels_settings_cancel()}
            </Button>
            <Button
              size="sm"
              isDisabled={saving}
              onPress={() => void save({ description: draft.trim() || null })}
            >
              {m.labels_settings_save()}
            </Button>
          </div>
        </div>
      )}

      {/* A refused color, restore or other change; the fields show their own. */}
      {error && editing !== "rename" && editing !== "description" && (
        <p role="alert" className="pl-6 text-sm text-error-primary">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirming === "archive"}
        onOpenChange={(open) => !open && setConfirming(null)}
        // Archiving can be undone: the primary button, not the red one.
        tone="default"
        title={m.labels_settings_archive_title({ name: label.name })}
        description={m.labels_settings_archive_body({ count: label.taskCount })}
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
        onOpenChange={(open) => !open && setConfirming(null)}
        title={m.labels_settings_delete_title({ name: label.name })}
        description={m.labels_settings_delete_body({ count: label.taskCount })}
        confirmLabel={m.labels_settings_delete()}
        errorMessage={(cause) => changeError(cause, label.name)}
        onConfirm={async () => {
          await remove({ data: { id: label.id } });
          await onChanged();
          setConfirming(null);
        }}
      />
    </li>
  );
}
