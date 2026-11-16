import { ChevronDown, MessageSquare01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { commentsCap } from "./artifact-comment-threads";

export function ArtifactCommentButton({
  total,
  active,
  onToggle,
  onShowAll,
}: {
  total: number | undefined;
  active: boolean;
  onToggle: () => void;
  onShowAll: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch overflow-hidden rounded-lg ring-1 ring-inset",
        active ? "bg-warning-secondary ring-utility-yellow-200" : "ring-secondary",
      )}
    >
      <Tooltip title={m.av_cm_toggle()}>
        <TooltipTrigger
          aria-label={m.av_cm_toggle()}
          aria-pressed={active}
          className={cn(
            "flex size-8 cursor-pointer items-center justify-center outline-focus-ring focus-visible:outline-2",
            active ? "text-warning-primary" : "text-fg-quaternary hover:bg-primary_hover",
          )}
          onPress={onToggle}
        >
          <MessageSquare01 aria-hidden="true" className="size-4" />
        </TooltipTrigger>
      </Tooltip>
      <Dropdown.Root>
        <AriaButton
          aria-label={m.av_cm_menu()}
          className={cn(
            "flex w-6 cursor-pointer items-center justify-center border-l outline-focus-ring focus-visible:outline-2",
            active
              ? "border-utility-yellow-200 text-warning-primary"
              : "border-secondary text-fg-quaternary hover:bg-primary_hover",
          )}
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </AriaButton>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label={m.av_cm_menu()} onAction={onShowAll}>
            <Dropdown.Item
              id="all"
              icon={MessageSquare01}
              label={m.av_cm_show_all({ count: total === undefined ? "…" : commentsCap(total) })}
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}
