import { useEffect, useState } from "react";
import { MessageSquare01 } from "@untitledui/icons";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { TOOLBAR_BUTTON_ON_CLASS } from "#src/features/conversations/review-chrome";
import { hotkeyKeycaps } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { commentsCap } from "./artifact-comment-threads";

export function ArtifactCommentButton({
  total,
  active,
  onToggle,
}: {
  total: number | undefined;
  active: boolean;
  onToggle: () => void;
}) {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    setApple(isApplePlatform());
  }, []);
  const label = m.av_cm_toggle();
  const count = total ? commentsCap(total) : undefined;
  const shortcut = hotkeyKeycaps("Shift+C", apple).join(apple ? "" : "+");
  return (
    <Tooltip
      title={
        <>
          {label}
          <kbd className="ml-2 rounded-xs px-1 font-sans text-xs font-medium text-tooltip-supporting-text ring-1 ring-current ring-inset">
            {shortcut}
          </kbd>
        </>
      }
    >
      <TooltipTrigger
        aria-label={count ? `${label} (${count})` : label}
        aria-pressed={active}
        className={cn(
          "relative flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 text-fg-quaternary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5",
          active && TOOLBAR_BUTTON_ON_CLASS,
        )}
        onPress={onToggle}
      >
        <MessageSquare01 aria-hidden="true" className="size-4" />
        {count && <span className="text-xs tabular-nums">{count}</span>}
      </TooltipTrigger>
    </Tooltip>
  );
}
