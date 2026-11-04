import type { ComponentProps, ReactNode } from "react";
import { Focusable } from "react-aria-components";

import { ActorName } from "#src/features/avatars/actor-name";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { getLocale } from "#src/paraglide/runtime";
import { cardActor } from "./action-card-actor";

/** When a card was handled, written only while its tooltip is open: the content mounts with the
 * tooltip, so a list of closed cards formats no times. */
function AnsweredAt({ value }: { value: string }) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  return formatMonthDayTime(value, timeZone, getLocale(), timeFormat);
}

/** The one element `Focusable` hands its hover and focus props to. */
export type FocusableLink = ComponentProps<typeof Focusable>["children"];

/**
 * A handled card's result in its one line, with when it was handled as its tooltip, after whoever
 * handled it when that is someone else. A `link` is already a focusable control and takes the
 * tooltip as it is; other text becomes a focusable inline trigger.
 */
export function AnsweredAtTooltip({
  at,
  by,
  ...result
}: { at: string; by?: ActionCardActor } & (
  | { link: FocusableLink; children?: never }
  | { link?: never; children: ReactNode }
)) {
  return (
    <Tooltip
      title={
        <>
          {by && (
            <>
              <ActorName actor={cardActor(by)} /> ·{" "}
            </>
          )}
          <AnsweredAt value={at} />
        </>
      }
    >
      {result.link ? (
        <Focusable>{result.link}</Focusable>
      ) : (
        <TooltipTrigger
          // A button never lays out inline, and the trigger's own `w-max` would hold a long result
          // on one line past the column: at the column's width it wraps instead.
          className="h-auto w-auto cursor-default rounded-sm text-left outline-focus-ring focus-visible:outline-2"
        >
          {result.children}
        </TooltipTrigger>
      )}
    </Tooltip>
  );
}
