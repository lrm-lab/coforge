import { ChevronRight } from "@untitledui/icons";
import { useId, useState, type FC, type ReactNode, type TransitionEvent } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Fold } from "#src/components/ui/fold";
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
  count,
  empty,
  icon: Icon,
  expanded,
  onToggle,
  headingProps,
  wrapTitle,
  trailing,
  children,
}: {
  label: string;
  count: number;
  empty?: boolean;
  icon?: FC<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
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
  const mark = Icon ? (
    <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
  ) : (
    <span aria-hidden="true" className="size-4 shrink-0" />
  );
  const caption = (
    <span className="flex w-full min-w-0 items-center gap-2">
      {mark}
      <span className="min-w-0 truncate text-sm font-medium text-primary">{label}</span>
      <span className="sr-only">, </span>
      <span className="shrink-0 text-sm font-normal text-quaternary tabular-nums">{count}</span>
    </span>
  );
  const toggle = () => {
    setEasesAfterToggle(true);
    onToggle?.();
  };
  const trailingSlot =
    trailing ?? (onToggle ? <span aria-hidden="true" className="w-7 shrink-0" /> : null);
  const chevron = onToggle ? (
    <Button
      color="tertiary"
      size="xs"
      aria-hidden="true"
      excludeFromTabOrder
      preventFocusOnPress
      onPress={toggle}
      className="hover:bg-transparent! active:bg-transparent!"
      iconLeading={
        <ChevronRight
          aria-hidden="true"
          className={cx(
            "size-4 shrink-0 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      }
    />
  ) : null;
  return (
    <>
      <div className={cx(DIRECTORY_INSET, "group/section")}>
        <div
          className={cx(
            "flex h-9 items-center gap-1 rounded-md pl-2 transition-colors duration-100 ease-out",
            trailingSlot || chevron ? "pr-1" : "pr-2",
            onToggle ? "group-hover/section:bg-primary_hover" : "cursor-pointer",
          )}
        >
          {onToggle ? (
            wrap(
              <Button
                {...headingProps}
                color="tertiary"
                size="sm"
                aria-expanded={expanded}
                aria-controls={listId}
                onPress={toggle}
                className="min-w-0 flex-1 justify-start pr-2 pl-0 hover:bg-transparent! [&_[data-text]]:min-w-0 [&_[data-text]]:flex-1 [&_[data-text]]:text-left"
              >
                {caption}
              </Button>,
            )
          ) : (
            <span {...headingProps} className="flex h-full min-w-0 flex-1 items-center pr-2">
              {caption}
            </span>
          )}
          {trailingSlot}
          {chevron}
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
