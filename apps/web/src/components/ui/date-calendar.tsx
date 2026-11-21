import { type CalendarDate, isSameDay, today } from "@internationalized/date";
import { ChevronLeft, ChevronRight } from "@untitledui/icons";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  Heading,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";

export function DateCalendar({
  label,
  value,
  timeZone,
  onChange,
}: {
  label: string;
  value: CalendarDate | null;
  timeZone: string;
  onChange: (date: CalendarDate) => void;
}) {
  const currentDay = today(timeZone);
  return (
    <Calendar
      aria-label={label}
      value={value}
      onChange={onChange}
      defaultFocusedValue={value ?? currentDay}
      firstDayOfWeek="mon"
      autoFocus
    >
      <header className="mb-2 flex items-center justify-between">
        <Button
          slot="previous"
          color="tertiary"
          size="sm"
          className="size-8"
          iconLeading={ChevronLeft}
        />
        <Heading className="text-sm font-semibold text-primary" />
        <Button
          slot="next"
          color="tertiary"
          size="sm"
          className="size-8"
          iconLeading={ChevronRight}
        />
      </header>
      <CalendarGrid
        weekdayStyle="short"
        className="w-full table-fixed border-separate border-spacing-y-0.5 text-center"
      >
        <CalendarGridHeader>
          {(day) => (
            <CalendarHeaderCell className="h-6 text-xs font-medium text-tertiary">
              {day}
            </CalendarHeaderCell>
          )}
        </CalendarGridHeader>
        <CalendarGridBody>
          {(date) => (
            <CalendarCell
              date={date}
              className="group relative mx-auto grid size-8 cursor-pointer place-items-center rounded-full text-sm text-primary outside-month:text-quaternary hover:bg-secondary_hover selected:bg-brand-solid selected:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
            >
              {({ formattedDate }) => (
                <>
                  {formattedDate}
                  {isSameDay(date, currentDay) && (
                    <span className="absolute bottom-0.5 size-1 rounded-full bg-brand-solid group-data-selected:bg-white" />
                  )}
                </>
              )}
            </CalendarCell>
          )}
        </CalendarGridBody>
      </CalendarGrid>
    </Calendar>
  );
}
