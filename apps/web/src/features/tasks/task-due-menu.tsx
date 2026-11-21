import { Calendar } from "@untitledui/icons";
import { useState, type ComponentProps } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { DateCalendar } from "#src/components/ui/date-calendar";
import { parseDate, parseTime, Time } from "@internationalized/date";
import {
  DateInput,
  DateSegment,
  Dialog,
  DialogTrigger,
  I18nProvider,
  Popover,
  TimeField,
} from "react-aria-components";
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
  onSelect: (dueAt: string | null, dueHasTime?: boolean) => void;
  placement?: ComponentProps<typeof Popover>["placement"];
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [withTime, setWithTime] = useState(Boolean(dueAt && (dueHasTime ?? true)));
  const [day, setDay] = useState("");
  const [time, setTime] = useState<Time | null>(null);
  const shown = dueAt
    ? formatTaskDueForDisplay(dueAt, dueHasTime, timeZone, getLocale(), timeFormat)
    : m.tasks_due_none();
  const instant =
    day && (!withTime || time)
      ? withTime
        ? instantFromLocalDateTime(`${day}T${time}`, timeZone)
        : instantFromLocalDate(day, timeZone)
      : null;
  const unchanged =
    dueAt &&
    day === localDateInput(dueAt, timeZone, dueHasTime ?? true) &&
    withTime === (dueHasTime ?? true) &&
    (!withTime || time?.toString().slice(0, 5) === localDateTimeInput(dueAt, timeZone).slice(11));
  const state = dueStateText(dueState);
  const close = () => setOpen(false);
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setWithTime(Boolean(dueAt && (dueHasTime ?? true)));
          setDay(dueAt ? localDateInput(dueAt, timeZone, dueHasTime ?? true) : "");
          setTime(
            dueAt && (dueHasTime ?? true)
              ? parseTime(localDateTimeInput(dueAt, timeZone).split("T")[1])
              : new Time(17),
          );
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
      <Popover
        placement={placement}
        className="untitled-ui w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-secondary bg-primary p-3 shadow-lg"
      >
        <Dialog aria-label={m.tasks_due()} className="outline-hidden">
          <I18nProvider locale={getLocale()}>
            <DateCalendar
              label={m.tasks_due()}
              value={day ? parseDate(day) : null}
              timeZone={timeZone}
              onChange={(date) => setDay(date.toString())}
            />
            <div className="mt-2 flex min-h-11 items-center justify-between gap-2 border-t border-secondary py-2">
              <Checkbox
                label={m.tasks_due_include_time()}
                isSelected={withTime}
                onChange={setWithTime}
              />
              {withTime && (
                <TimeField
                  aria-label={m.tasks_due_include_time()}
                  value={time}
                  onChange={setTime}
                  hourCycle={24}
                  granularity="minute"
                >
                  <DateInput className="flex rounded-lg border border-primary px-2 py-1 text-sm text-primary">
                    {(segment) => (
                      <DateSegment
                        segment={segment}
                        className="rounded px-px tabular-nums outline-hidden focus:bg-brand-solid focus:text-white"
                      />
                    )}
                  </DateInput>
                </TimeField>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              {dueAt && (
                <Button
                  size="sm"
                  color="tertiary"
                  isDisabled={disabled}
                  onClick={() => {
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
                isDisabled={disabled || instant === null || Boolean(unchanged)}
                onClick={() => {
                  if (instant === null) return;
                  onSelect(instant, withTime);
                  close();
                }}
              >
                {m.tasks_due_set()}
              </Button>
            </div>
          </I18nProvider>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
