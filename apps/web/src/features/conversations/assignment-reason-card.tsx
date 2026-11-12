import { useLayoutEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { cn } from "#src/lib/utils";

/**
 * The reason an assignment gives (`task assign --reason`, task #83), on a line of its own under
 * the notice, in the notice's own size and ink: the stream draws it as one more notice row, not a
 * card (Frank, task #92). A reason past three lines is clamped, and pressing it shows it whole in
 * place for good: a phone has no hover, so a tooltip would leave the rest unreachable there, and
 * once open it is plain text again, which can be selected and copied (a button's text cannot).
 */
export function AssignmentReason({ reason }: { reason: string }) {
  const [reasonElement, setReasonElement] = useState<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const clamped = useClamped(reasonElement, expanded);
  const text = (
    <span
      ref={setReasonElement}
      data-assignment-reason
      className={cn(
        "block break-words whitespace-pre-line text-tertiary",
        !expanded && "line-clamp-3",
      )}
    >
      {reason}
    </span>
  );
  // Only a clamped reason has more to show, so only then is it a control.
  return clamped && !expanded ? (
    <AriaButton
      aria-expanded={false}
      onPress={() => setExpanded(true)}
      className="min-w-0 cursor-pointer rounded-sm text-center outline-focus-ring transition-colors duration-100 focus-visible:outline-2 [&>span]:transition-colors [&>span]:duration-100 hover:[&>span]:text-secondary active:[&>span]:text-secondary"
    >
      {text}
    </AriaButton>
  ) : (
    text
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
