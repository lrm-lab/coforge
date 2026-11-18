import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  COLLAPSED_MESSAGE_MAX_HEIGHT,
  overflowsCollapsedMessage,
} from "./collapsed-message-height";
import { MessageBody } from "./message-body";

export function CollapsibleMessageBody({
  body,
  mentions,
  expanded,
  collapsible = true,
  onToggleExpanded,
  trailing,
  ...bodyProps
}: ComponentProps<typeof MessageBody> & {
  expanded: boolean;
  collapsible?: boolean;
  onToggleExpanded: () => void;
}) {
  return (
    <CollapsibleBlock
      measureKey={body}
      expanded={expanded}
      collapsible={collapsible}
      onToggleExpanded={onToggleExpanded}
      trailing={trailing}
      className="message-text text-md"
    >
      {(collapsed) => (
        <MessageBody
          body={body}
          mentions={mentions}
          trailing={collapsed ? undefined : trailing}
          {...bodyProps}
        />
      )}
    </CollapsibleBlock>
  );
}

export function CollapsibleBlock({
  measureKey,
  expanded,
  collapsible,
  onToggleExpanded,
  trailing,
  className,
  children,
}: {
  measureKey: string;
  expanded: boolean;
  collapsible: boolean;
  onToggleExpanded: () => void;
  trailing?: ReactNode;
  className?: string;
  children: (collapsed: boolean) => ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !collapsible) return;
    const measure = () =>
      setOverflowing(
        overflowsCollapsedMessage(
          content.scrollHeight,
          Number.parseFloat(getComputedStyle(content).lineHeight),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [measureKey, collapsible]);

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
        className={cn(
          className,
          collapsed &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
        )}
        style={collapsed ? { maxHeight: COLLAPSED_MESSAGE_MAX_HEIGHT } : undefined}
      >
        {children(collapsed)}
      </div>
      {foldable && (
        <div className="flex items-center">
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
          {collapsed && trailing}
        </div>
      )}
    </>
  );
}
