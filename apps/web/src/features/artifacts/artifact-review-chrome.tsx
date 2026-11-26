import { Button as AriaButton, Toolbar } from "react-aria-components";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Cursor02,
  Edit03,
  Plus,
  Trash01,
  XClose,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { HotkeyKeycaps, TooltipShortcutLabel } from "#src/components/ui/kbd";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { hasImages, type CommentDraftView } from "./artifact-comment-drafts-queries";
import type { CommentAnchor } from "./artifact-comment-inputs";
import { InlineRefText } from "./artifact-inline-ref-text";
import { extractElementTag } from "./artifact-inline-refs";

export const SECONDARY_PILL_CLASS =
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-tertiary px-3.5 text-xs font-medium text-primary outline-focus-ring transition-colors duration-150 hover:bg-secondary_hover focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40";

export const PRIMARY_PILL_CLASS =
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-alpha-black px-3.5 text-xs font-medium text-alpha-white outline-focus-ring transition-opacity duration-150 hover:opacity-88 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40";

export const TERTIARY_PILL_CLASS =
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-primary focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40";

export function formatAnchorTag(anchor: CommentAnchor | null, path?: string | null): string {
  if (anchor?.type === "element") {
    const selector = typeof anchor.data.selector === "string" ? anchor.data.selector.trim() : "";
    if (selector) return `<${extractElementTag(selector)}>`;
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (quote) return quote.length > 26 ? `“${quote.slice(0, 26)}…”` : quote;
    return path || "page";
  }
  if (anchor?.type === "text") {
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (!quote) return path || "page";
    return quote.length > 26 ? `“${quote.slice(0, 26)}…”` : `“${quote}”`;
  }
  if (anchor?.type === "lines") {
    const start = Number(anchor.data.start ?? 0);
    const end = Number(anchor.data.end ?? start);
    if (start > 0) return start === end ? `L${start}` : `L${start}–${end}`;
  }
  if (anchor?.type === "page") {
    const label =
      typeof anchor.data.label === "string" && anchor.data.label.trim()
        ? anchor.data.label.trim()
        : typeof anchor.data.name === "string"
          ? anchor.data.name.trim()
          : "";
    if (label) return label;
  }
  return path || "page";
}

export function AnchorChip({
  label,
  onRemove,
  className,
}: {
  label: string;
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-48 items-center gap-1 rounded-md bg-brand-secondary px-1.5 py-0.5 font-mono text-xs font-medium text-brand-secondary",
        className,
      )}
    >
      <Cursor02
        aria-hidden="true"
        strokeWidth={1.5}
        className="size-2.5 shrink-0 text-fg-brand-primary"
      />
      <span className="truncate">{label}</span>
      {onRemove && (
        <AriaButton
          aria-label={m.controls_cancel()}
          onPress={onRemove}
          className="ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-tertiary transition-colors hover:text-primary"
        >
          <XClose className="size-2.5" />
        </AriaButton>
      )}
    </span>
  );
}

export function ArtifactReviewQueue({
  drafts,
  focusedIdx,
  locked,
  atLimit,
  onOpenDraft,
  onEditDraft,
  onRemoveDraft,
  onCollapse,
  onNewComment,
  onSubmit,
}: {
  drafts: readonly CommentDraftView[];
  focusedIdx: number;
  locked: boolean;
  atLimit: boolean;
  onOpenDraft: (draft: CommentDraftView) => void;
  onEditDraft: (draft: CommentDraftView) => void;
  onRemoveDraft: (draft: CommentDraftView) => void | Promise<void>;
  onCollapse: () => void;
  onNewComment: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <ul className="max-h-60 divide-y divide-secondary/70 overflow-y-auto">
        {drafts.map((draft, index) => (
          <li
            key={draft.id}
            className={cn(
              "flex items-center gap-2.5 px-3.5 py-2.5 transition-colors duration-150",
              focusedIdx === index && "bg-secondary/60",
            )}
          >
            <AriaButton
              onPress={() => onOpenDraft(draft)}
              className="min-w-0 flex-1 cursor-pointer text-left text-sm leading-snug text-primary outline-focus-ring focus-visible:outline-2"
            >
              <InlineRefText body={draft.body} anchor={draft.anchor} path={draft.path} />
            </AriaButton>
            <div className="flex shrink-0 items-center gap-0.5">
              <ButtonUtility
                icon={Edit03}
                size="xs"
                color="tertiary"
                tooltip={m.av_cm_edit()}
                tooltipShortcut="E"
                isDisabled={locked}
                onClick={() => onEditDraft(draft)}
              />
              <Popconfirm
                isDisabled={!hasImages(draft)}
                title={m.av_dr_delete_title()}
                description={m.av_dr_delete_body()}
                confirmLabel={m.av_dr_delete_confirm()}
                errorMessage={m.av_dr_delete_failed()}
                placement="top end"
                onConfirm={async () => {
                  await onRemoveDraft(draft);
                }}
              >
                <ButtonUtility
                  icon={Trash01}
                  size="xs"
                  color="tertiary"
                  tooltip={m.av_cm_delete()}
                  tooltipShortcut="Backspace"
                  isDisabled={locked}
                  onClick={() => {
                    if (!hasImages(draft)) void onRemoveDraft(draft);
                  }}
                />
              </Popconfirm>
            </div>
          </li>
        ))}
      </ul>
      <TooltipGroup className="flex items-center justify-between gap-2 border-t border-secondary/70 px-3 py-2.5">
        <Tooltip title={<TooltipShortcutLabel label={m.av_dr_collapse()} shortcut="Escape" />}>
          <AriaButton onPress={onCollapse} className={cn(TERTIARY_PILL_CLASS, "gap-1 px-2.5")}>
            <span>{m.av_dr_collapse()}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </AriaButton>
        </Tooltip>
        <div className="flex items-center gap-2">
          <Tooltip title={<TooltipShortcutLabel label={m.av_dr_new_comment()} shortcut="N" />}>
            <AriaButton
              isDisabled={locked || atLimit}
              onPress={onNewComment}
              className={SECONDARY_PILL_CLASS}
            >
              <Plus aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{m.av_dr_new_comment()}</span>
            </AriaButton>
          </Tooltip>
          <Tooltip
            title={<TooltipShortcutLabel label={m.av_dr_send_all_tip()} shortcut="Mod+Enter" />}
          >
            <AriaButton
              isDisabled={locked}
              data-draft-send=""
              aria-label={m.av_dr_send_all_tip()}
              onPress={onSubmit}
              className={PRIMARY_PILL_CLASS}
            >
              <span>{m.av_dr_send_all()}</span>
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
            </AriaButton>
          </Tooltip>
        </div>
      </TooltipGroup>
    </>
  );
}

export function ArtifactReviewBar({
  annotating,
  count,
  locked,
  onExitAnnotate,
  onOpenQueue,
  onSubmit,
}: {
  annotating: boolean;
  count: number;
  locked: boolean;
  onExitAnnotate: () => void;
  onOpenQueue: () => void;
  onSubmit: () => void;
}) {
  if (count > 0) {
    return (
      <Toolbar
        aria-label={m.av_dr_tools()}
        className={cn(
          "pointer-events-auto flex max-w-[calc(100vw-2rem)] min-w-0 items-center gap-1 rounded-full p-1",
          FLOATING_SURFACE_CLASS,
        )}
      >
        <AriaButton
          aria-expanded={false}
          aria-label={m.av_dr_pending_pill({ count })}
          onPress={onOpenQueue}
          className="relative inline-flex h-8 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-primary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5"
        >
          <span className="truncate tabular-nums max-[26rem]:hidden">
            {m.av_dr_pending_pill({ count })}
          </span>
          <span className="truncate tabular-nums min-[26rem]:hidden">
            {m.av_dr_pending_pill_short({ count })}
          </span>
          <ChevronUp aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        </AriaButton>
        <Tooltip
          title={<TooltipShortcutLabel label={m.av_dr_send_all_tip()} shortcut="Mod+Enter" />}
        >
          <AriaButton
            isDisabled={locked}
            data-draft-send=""
            aria-label={m.av_dr_send_all_tip()}
            onPress={onSubmit}
            className={PRIMARY_PILL_CLASS}
          >
            <span>{m.av_dr_send_all()}</span>
            <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
          </AriaButton>
        </Tooltip>
      </Toolbar>
    );
  }

  if (!annotating) return null;

  return (
    <div
      role="status"
      aria-label={m.av_dr_tools()}
      className={cn(
        "pointer-events-auto flex max-w-[calc(100vw-2rem)] min-w-0 items-center gap-1 p-1",
        FLOATING_SURFACE_CLASS,
      )}
    >
      <div className="inline-flex h-8 min-w-0 items-center gap-2 pr-1.5 pl-2.5 text-xs font-medium text-primary select-none">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand-solid" />
        <span className="truncate max-[26rem]:hidden">{m.av_cm_pick_prompt()}</span>
        <span className="truncate min-[26rem]:hidden">{m.av_cm_pick_prompt_short()}</span>
      </div>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border-secondary" />
      <AriaButton
        aria-label={m.av_cm_exit_annotate()}
        onPress={onExitAnnotate}
        className="relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-primary focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-1.5"
      >
        <span className="max-[26rem]:hidden">{m.av_cm_exit_annotate()}</span>
        <span className="min-[26rem]:hidden">{m.av_cm_exit_short()}</span>
        <HotkeyKeycaps
          hotkey="Escape"
          size="xs"
          hideOnTouch
          ariaHidden
          className="max-[26rem]:hidden"
        />
      </AriaButton>
    </div>
  );
}
