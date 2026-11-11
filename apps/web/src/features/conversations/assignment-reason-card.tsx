import { useLayoutEffect, useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

import { cn } from "#src/lib/utils";

/**
 * An assignment that says what it is for (`task assign --reason`, task #83), as a card of two
 * lines centred on the stream's rule: the notice, wrapping under its time so who the Task went to
 * is never cut (even with text at 200%), then the reason in body ink. A reason past three lines
 * is clamped, and pressing it shows it whole in place for good: a phone has no hover, so a tooltip
 * would leave the rest unreachable there, and once open it is plain text again, which can be
 * selected and copied (a button's text cannot).
 */
export function AssignmentReasonCard({
  time,
  notice,
  reason,
}: {
  time: ReactNode;
  notice: ReactNode;
  reason: string;
}) {
  const [reasonElement, setReasonElement] = useState<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const clamped = useClamped(reasonElement, expanded);
  const text = (
    <span
      ref={setReasonElement}
      data-assignment-reason
      className={cn(
        "block text-sm break-words whitespace-pre-line text-secondary",
        !expanded && "line-clamp-3",
      )}
    >
      {reason}
    </span>
  );
  return (
    <div
      data-assignment-reason-card
      className="flex max-w-xl min-w-0 flex-col gap-1 rounded-lg border border-secondary bg-primary px-3 py-2"
    >
      <p className="min-w-0 break-words">
        <span className="mr-2">{time}</span>
        {notice}
      </p>
      {/* Only a clamped reason has more to show, so only then is it a control. */}
      {clamped && !expanded ? (
        <AriaButton
          aria-expanded={false}
          onPress={() => setExpanded(true)}
          className="min-w-0 cursor-pointer rounded-sm text-left outline-focus-ring transition-colors duration-100 focus-visible:outline-2 [&>span]:transition-colors [&>span]:duration-100 hover:[&>span]:text-primary active:[&>span]:text-primary"
        >
          {text}
        </AriaButton>
      ) : (
        text
      )}
    </div>
  );
}

/** Whether the element's text runs past its clamp, kept current as the column resizes. */
function useClamped(element: HTMLElement | null, expanded: boolean) {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, expanded]);
  return clamped;
}
