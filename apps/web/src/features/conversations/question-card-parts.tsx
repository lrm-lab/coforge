import type { ReactNode } from "react";
import { Check } from "@untitledui/icons";

import { cn } from "#src/lib/utils";

export function Mark({
  on,
  many,
  dim,
  className,
}: {
  on: boolean;
  many: boolean;
  dim?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-4.5 shrink-0 place-items-center transition-[background-color,box-shadow] duration-100 ease-out",
        many ? "rounded-[0.3125rem]" : "rounded-full",
        on
          ? dim
            ? "bg-fg-quaternary text-white"
            : "bg-fg-primary text-bg-primary"
          : dim
            ? "text-white shadow-[inset_0_0_0_1.5px_var(--color-border-secondary)]"
            : "text-bg-primary shadow-[inset_0_0_0_1.5px_var(--color-border-primary)]",
        className,
      )}
    >
      <Check
        className={cn(
          "size-3 transition-[opacity,scale] motion-reduce:transition-opacity motion-reduce:duration-150 motion-reduce:ease-out",
          on
            ? "scale-100 opacity-100 duration-[calc(var(--duration-sm)*1.5)] ease-overshoot"
            : "scale-50 opacity-0 duration-(--duration-sm-out) ease-in motion-reduce:scale-100",
        )}
      />
    </span>
  );
}

export const OPTION_ROW =
  "flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm min-h-10 max-sm:min-h-12 max-sm:py-3";

export const OPTION_ROW_LIVE =
  "cursor-pointer border-secondary pointer-fine:hover:border-primary pointer-fine:hover:bg-secondary active:bg-secondary";

export function QuestionPageStack<T extends { id: string }>({
  items,
  activeIndex,
  renderSizer,
  children,
}: {
  items: readonly T[];
  activeIndex: number;
  renderSizer: (item: T) => ReactNode;
  children: ReactNode;
}) {
  if (items.length <= 1) return <div className="flex flex-col">{children}</div>;
  return (
    <div className="grid">
      {items.map((item, index) =>
        index === activeIndex ? null : (
          <div
            key={item.id}
            aria-hidden="true"
            inert
            className="pointer-events-none invisible col-start-1 row-start-1 flex min-w-0 flex-col select-none"
          >
            {renderSizer(item)}
          </div>
        ),
      )}
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col">{children}</div>
    </div>
  );
}
