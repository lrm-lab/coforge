import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  COLLAPSED_MESSAGE_MAX_HEIGHT,
  overflowsCollapsedMessage,
} from "./collapsed-message-height";
import { MessageBody } from "./message-body";

/**
 * A message body that collapses when it is very long, with a control to show the rest — Slack's
 * treatment for a wall of text.
 *
 * Only bodies that actually overflow get the control, and that is measured rather than inferred
 * from the text: the same 400 characters are three lines wide on a desktop and ten on a phone, and
 * Markdown makes any text-based rule worse — four short headings are four source lines but
 * far more than four rendered ones, and a table or code block owns height its length does not
 * predict. So every body is measured; nothing is pre-filtered. A `line-clamp` cannot do this job
 * either (it needs an inline formatting context, and a Markdown body is a stack of block
 * elements), so the collapsed state is a `max-height` on a multiple of the line height, with a
 * mask fading the last line so the cut reads as "there is more" rather than as a clipped row.
 *
 * The collapsed body stays an ordinary interactive body, as Raft's does: a link, mention or task
 * chip above the cut works, and the clip keeps a pointer from reaching anything below it. Focus
 * that lands below the cut (a Tab into a link nobody can see) expands the message, so the
 * keyboard never works blind. A collapse is a device for saving screen space, not for withholding
 * the message: assistive technology reads the whole body, clipped part included, and a
 * screen-reader user never has to operate a visual control to hear it.
 *
 * `expanded` is owned by the conversation, not by this component: a row unmounts as soon as it
 * scrolls out of the virtualizer's window, and an expanded message must not silently re-collapse
 * behind the reader.
 */
export function CollapsibleMessageBody({
  body,
  mentions,
  expanded,
  collapsible = true,
  onToggleExpanded,
  ...bodyProps
}: ComponentProps<typeof MessageBody> & {
  expanded: boolean;
  /** Off (the viewer turned "Collapse long messages" off here): the body always shows in full,
   * and nothing is measured. */
  collapsible?: boolean;
  onToggleExpanded: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !collapsible) return;
    // Compare the body's full height with the collapsed height, never with its own client height:
    // `overflow-hidden` is applied only once we know it overflows, so measuring the clamp would
    // never see an overflow in the first place. `scrollHeight` is the full content height in both
    // states, which also keeps the control visible while expanded — the reader needs the way back.
    // The collapsed height is four of the body's own lines, read at measure time.
    const measure = () =>
      setOverflowing(
        overflowsCollapsedMessage(
          content.scrollHeight,
          Number.parseFloat(getComputedStyle(content).lineHeight),
        ),
      );
    measure();
    // The clamped height depends on the width, which changes with the window, the sidebar and the
    // thread panel, and on the text and message font sizes, which also resize the body. The control renders *below* the clamped box, so this cannot feed back into its
    // own measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [body, collapsible]);

  // Off, nothing folds and no control shows, whatever the last measurement said.
  const foldable = collapsible && overflowing;
  const collapsed = foldable && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        onFocusCapture={(event) => {
          if (!collapsed) return;
          const content = event.currentTarget.getBoundingClientRect();
          if (event.target.getBoundingClientRect().bottom > content.bottom) onToggleExpanded();
        }}
        // `overflow-hidden` only while collapsed: a code block or table inside the body keeps its
        // own horizontal scrolling when the body is open.
        // `message-text` is what Settings → Message font size scales (`message-markdown.css`): the
        // body only, so the Show more control below keeps the UI size.
        className={cn(
          "message-text text-md",
          collapsed &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
        )}
        style={collapsed ? { maxHeight: COLLAPSED_MESSAGE_MAX_HEIGHT } : undefined}
      >
        <MessageBody body={body} mentions={mentions} {...bodyProps} />
      </div>
      {foldable && (
        <Button
          color="link-gray"
          size="sm"
          className="mt-0.5 w-fit font-semibold"
          aria-expanded={expanded}
          onPress={onToggleExpanded}
          iconTrailing={
            <ChevronDown
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
            />
          }
        >
          {expanded ? m.conversation_message_show_less() : m.conversation_message_show_more()}
        </Button>
      )}
    </>
  );
}
