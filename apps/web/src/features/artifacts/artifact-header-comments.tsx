import { ChevronDown, CursorBox, MessageSquare01, Monitor02 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { TOOLBAR_BUTTON_ON_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactCommentButton } from "./artifact-comment-button";
import { commentsCap } from "./artifact-comment-threads";

export function ArtifactHeaderComments({
  html,
  total,
  annotating,
  panelActive,
  onToggleAnnotate,
  onTogglePanel,
  onDisplayReport,
}: {
  html: boolean;
  total: number | undefined;
  annotating: boolean;
  panelActive: boolean;
  onToggleAnnotate: () => void;
  onTogglePanel: () => void;
  onDisplayReport?: () => void;
}) {
  if (!html) {
    return <ArtifactCommentButton total={total} active={panelActive} onToggle={onTogglePanel} />;
  }

  const count = total ? commentsCap(total) : undefined;
  const showAllLabel = count ? m.av_cm_show_all_count({ count }) : m.av_cm_show_all();

  return (
    <div className="inline-flex h-8 shrink-0 items-center divide-x divide-border-secondary rounded-lg border border-secondary bg-primary">
      <Tooltip title={m.av_cm_pick_element()}>
        <TooltipTrigger
          aria-label={m.av_cm_pick_element()}
          aria-pressed={annotating}
          onPress={onToggleAnnotate}
          className={cn(
            "relative flex h-full min-w-8 cursor-pointer items-center justify-center rounded-l-lg px-2 text-fg-quaternary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5",
            annotating && TOOLBAR_BUTTON_ON_CLASS,
          )}
        >
          <CursorBox aria-hidden="true" className="size-4 shrink-0" />
        </TooltipTrigger>
      </Tooltip>
      <Dropdown.Root>
        <AriaButton
          aria-label={count ? `${m.av_cm_toggle()} (${count})` : m.av_cm_toggle()}
          className={cn(
            "relative flex h-full min-w-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-r-lg px-2 text-fg-quaternary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5",
            panelActive && TOOLBAR_BUTTON_ON_CLASS,
          )}
        >
          {count ? (
            <span className="text-xs font-medium text-secondary tabular-nums">{count}</span>
          ) : (
            <MessageSquare01 aria-hidden="true" className="size-4" />
          )}
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </AriaButton>
        <Dropdown.Popover placement="bottom end" className="w-56">
          <Dropdown.Menu
            aria-label={m.av_cm_toggle()}
            onAction={(key) => {
              if (key === "all") onTogglePanel();
              else if (key === "display-report") onDisplayReport?.();
            }}
          >
            <Dropdown.Item id="all" icon={MessageSquare01} label={showAllLabel} />
            {onDisplayReport && (
              <Dropdown.Item id="display-report" icon={Monitor02} label={m.av_cm_display_issue()} />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}
