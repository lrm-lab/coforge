import { Calendar } from "@untitledui/icons";
import { useState, type ComponentProps } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import {
  formatTaskDueForDisplay,
  instantFromLocalDate,
  instantFromLocalDateTime,
  localDateInput,
  localDateTimeInput,
} from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { TaskFieldTrigger } from "./task-field-trigger";
import { UnsetValue } from "./task-property";

function dueStateText(dueState: "overdue" | "due_soon" | null | undefined) {
  if (dueState === "overdue") return m.tasks_due_overdue();
  if (dueState === "due_soon") return m.tasks_due_soon();
  return null;
}

/**
 * A Task's due instant, in its popup and in the form that makes one. The field edits local wall
 * time; the stored value is the instant it names. Clearing returns the Task to no due date.
 */
export function TaskDueMenu({
  dueAt,
  dueHasTime,
  dueState,
  disabled,
  onSelect,
  placement = "bottom start",
}: {
  dueAt?: string | null;
  dueHasTime?: boolean;
  dueState?: "overdue" | "due_soon" | null;
  disabled: boolean;
  /** The new instant as ISO and whether it includes time, or null to clear. */
  onSelect: (dueAt: string | null, dueHasTime?: boolean) => void;
  placement?: ComponentProps<typeof Dropdown.Popover>["placement"];
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [withTime, setWithTime] = useState(Boolean(dueHasTime));
  const [draft, setDraft] = useState<string | null>(null);
  const shown = dueAt
    ? formatTaskDueForDisplay(dueAt, dueHasTime, timeZone, getLocale(), timeFormat)
    : m.tasks_due_none();
  const value =
    draft ??
    (dueAt
      ? withTime
        ? localDateTimeInput(dueAt, timeZone)
        : localDateInput(dueAt, timeZone, dueHasTime ?? true)
      : "");
  const instant = (() => {
    if (draft === null || !draft) return null;
    try {
      return withTime
        ? instantFromLocalDateTime(draft, timeZone)
        : instantFromLocalDate(draft, timeZone);
    } catch {
      return null;
    }
  })();
  const state = dueStateText(dueState);
  const close = () => setOpen(false);
  return (
    <Dropdown.Root
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setWithTime(Boolean(dueHasTime));
          setDraft(null);
        }
      }}
    >
      <TaskFieldTrigger label={`${m.tasks_due()}: ${shown}`} disabled={disabled}>
        {dueAt ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary">
            <Calendar aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
            <span className="truncate">
              {shown}
              {state ? ` · ${state}` : ""}
            </span>
          </span>
        ) : (
          <UnsetValue icon={Calendar} text={m.tasks_due_none()} field={m.tasks_due()} />
        )}
      </TaskFieldTrigger>
      <Dropdown.Popover placement={placement} className="w-64 p-3">
        <div className="flex flex-col gap-2">
          <Input
            type={withTime ? "datetime-local" : "date"}
            aria-label={m.tasks_due()}
            value={value}
            onChange={setDraft}
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-secondary select-none">
            <input
              type="checkbox"
              checked={withTime}
              onChange={(event) => {
                const next = event.target.checked;
                setWithTime(next);
                if (next && value && !value.includes("T")) setDraft(`${value}T17:00`);
                else if (!next && value.includes("T")) setDraft(value.slice(0, 10));
              }}
            />
            <span>HH:mm</span>
          </label>
          <div className="flex items-center justify-end gap-2">
            {dueAt && (
              <Button
                size="sm"
                color="tertiary"
                isDisabled={disabled}
                onClick={() => {
                  setDraft(null);
                  onSelect(null);
                  close();
                }}
              >
                {m.tasks_due_clear()}
              </Button>
            )}
            <Button
              size="sm"
              color="primary"
              isDisabled={disabled || instant === null}
              onClick={() => {
                if (instant === null) return;
                onSelect(instant, withTime);
                setDraft(null);
                close();
              }}
            >
              {m.tasks_due_set()}
            </Button>
          </div>
        </div>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
