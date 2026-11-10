import type { FC, ReactNode } from "react";
import { ChevronRight } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { cx } from "#src/utils/cx";

const ROW_CLASS =
  "flex h-14 w-full items-center gap-3 px-page text-left text-md font-medium outline-focus-ring transition-colors duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2";

/**
 * One row of a tab page's list (the Workspace tab, Me): an icon, the label, what the row carries
 * (`badge`), and a chevron when it leads to a page. A link with `href`, else a button with
 * `onPress`; `destructive` takes the error ink and no chevron.
 */
export function TabPageRow({
  icon: Icon,
  label,
  href,
  onPress,
  badge,
  destructive = false,
}: {
  icon: FC<{ className?: string }>;
  label: string;
  href?: string;
  onPress?: () => void;
  badge?: ReactNode;
  destructive?: boolean;
}) {
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className={cx("size-5 shrink-0", destructive ? "text-error-primary" : "text-fg-quaternary")}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
      {!destructive && (
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-fg-quaternary" />
      )}
    </>
  );
  const ink = destructive ? "text-error-primary" : "text-primary";
  return (
    <li>
      {href ? (
        <a href={href} className={cx(ROW_CLASS, ink)}>
          {content}
        </a>
      ) : (
        <AriaButton onPress={onPress} className={cx(ROW_CLASS, ink)}>
          {content}
        </AriaButton>
      )}
    </li>
  );
}
