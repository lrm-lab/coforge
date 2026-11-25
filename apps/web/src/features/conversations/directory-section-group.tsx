import { ChevronRight } from "@untitledui/icons";
import { useId, useState, type ReactNode, type TransitionEvent } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Fold } from "#src/components/ui/fold";
import { CountBadge } from "#src/components/ui/unread-marker";
import { cx } from "#src/utils/cx";
import type { DirectoryDragActivation } from "./directory-drag";

export const DIRECTORY_INSET = "px-3";

export function DirectoryEmptyNote({ children }: { children: ReactNode }) {
  return (
    <li className="flex h-9 items-center px-2 text-xs text-quaternary">
      <span className="truncate">{children}</span>
    </li>
  );
}

export function DirectorySection({
  label,
  leading,
  count,
  empty,
  expanded,
  onToggle,
  headingProps,
  wrapTitle,
  trailing,
  children,
}: {
  label: string;
  leading?: ReactNode;
  count: number;
  empty?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  headingProps?: DirectoryDragActivation;
  wrapTitle?: (toggle: ReactNode) => ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const listId = useId();
  const wrap = wrapTitle ?? ((toggle: ReactNode) => toggle);
  const [easesAfterToggle, setEasesAfterToggle] = useState(false);
  const stopEasingWhenFoldEnds = (event: TransitionEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget.firstElementChild &&
      event.propertyName === "grid-template-rows"
    )
      setEasesAfterToggle(false);
  };
  const mark = onToggle ? (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <ChevronRight
        aria-hidden="true"
        className={cx(
          "size-3.5 shrink-0 text-fg-quaternary transition-transform duration-(--duration-sm) ease-in-out group-hover/section:text-fg-quaternary_hover motion-reduce:transition-none",
          expanded ? "rotate-90" : "rtl:rotate-180",
        )}
      />
    </span>
  ) : null;
  const caption = (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        {mark}
        {leading}
        <span className="min-w-0 truncate text-sm font-medium text-primary">{label}</span>
      </span>
      {count > 0 && <span className="sr-only">, {count}</span>}
      <CountBadge count={count} size="sm" />
    </span>
  );
  const toggle = () => {
    setEasesAfterToggle(true);
    onToggle?.();
  };
  return (
    <>
      <div className={cx(DIRECTORY_INSET, "group/section")}>
        <div
          className={cx(
            "flex h-9 items-center gap-1 rounded-md ps-2 transition-colors duration-100 ease-out",
            trailing ? "pe-1" : "pe-2",
            onToggle ? "group-hover/section:bg-primary_hover" : "cursor-pointer",
          )}
        >
          {onToggle ? (
            wrap(
              <Button
                {...headingProps}
                color="tertiary"
                size="sm"
                noTextPadding
                aria-expanded={expanded}
                aria-controls={listId}
                onPress={toggle}
                className="min-w-0 flex-1 justify-start ps-0 pe-2 hover:bg-transparent! [&_[data-text]]:min-w-0 [&_[data-text]]:flex-1 [&_[data-text]]:text-start"
              >
                {caption}
              </Button>,
            )
          ) : (
            <span {...headingProps} className="flex h-full min-w-0 flex-1 items-center pe-2">
              {caption}
            </span>
          )}
          {trailing}
        </div>
      </div>
      <div onTransitionEnd={stopEasingWhenFoldEnds}>
        <Fold
          open={expanded !== false}
          className={easesAfterToggle ? undefined : "transition-none"}
        >
          <div
            id={listId}
            className={
              empty
                ? undefined
                : "pb-[1.6875rem] has-[>div>ul>li:last-child_[data-row-card]]:pb-[1.625rem]"
            }
          >
            {children}
          </div>
        </Fold>
      </div>
    </>
  );
}
