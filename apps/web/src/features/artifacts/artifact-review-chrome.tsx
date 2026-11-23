import { Button as AriaButton } from "react-aria-components";
import {
  ArrowRight,
  Cursor02,
  CursorBox,
  Edit03,
  MessageSquare01,
  Plus,
  Trash01,
  XClose,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { TooltipShortcutLabel } from "#src/components/ui/kbd";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { hasImages, type CommentDraftView } from "./artifact-comment-drafts-queries";
import type { CommentAnchor } from "./artifact-comment-inputs";
import { InlineRefText } from "./artifact-inline-editor";
import { extractElementTag } from "./artifact-inline-refs";

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
  onNewComment,
  onSubmit,
}: {
  drafts: readonly CommentDraftView[];
  focusedIdx: number;
  locked: boolean;
  atLimit: boolean;
  onOpenDraft: (draft: CommentDraftView) => void;
  onEditDraft: (draft: CommentDraftView) => void;
  onRemoveDraft: (draft: CommentDraftView) => void;
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
                    if (!hasImages(draft)) onRemoveDraft(draft);
                  }}
                />
              </Popconfirm>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-secondary/70 px-3.5 py-2.5">
        <CoForgeMark className="h-3.5 shrink-0 opacity-60 transition-opacity duration-150 hover:opacity-90" />
        <div className="flex items-center gap-2">
          <Tooltip title={<TooltipShortcutLabel label={m.av_dr_new_comment()} shortcut="N" />}>
            <Button
              size="sm"
              color="secondary"
              iconLeading={Plus}
              isDisabled={locked || atLimit}
              onPress={onNewComment}
            >
              {m.av_dr_new_comment()}
            </Button>
          </Tooltip>
          <Tooltip
            title={<TooltipShortcutLabel label={m.av_dr_send_all_tip()} shortcut="Mod+Enter" />}
          >
            <Button
              size="sm"
              color="primary"
              iconTrailing={ArrowRight}
              isDisabled={locked}
              data-draft-send=""
              aria-label={m.av_dr_send_all_tip()}
              onPress={onSubmit}
            >
              {m.av_dr_send_all()}
            </Button>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

export function ArtifactReviewBar({
  annotating,
  count,
  cardOpen,
  locked,
  onToggleAnnotate,
  onToggleCard,
  onSubmit,
}: {
  annotating: boolean;
  count: number;
  cardOpen: boolean;
  locked: boolean;
  onToggleAnnotate: () => void;
  onToggleCard: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={m.av_dr_tools()}
      className={cn(
        "pointer-events-auto flex max-w-[calc(100vw-2rem)] min-w-0 items-center gap-1.5 px-2 py-1.5 max-[26rem]:gap-1 max-[26rem]:px-1.5",
        FLOATING_SURFACE_CLASS,
      )}
    >
      <Tooltip
        title={
          annotating ? (
            <TooltipShortcutLabel label={m.av_cm_annotating()} shortcut="Escape" />
          ) : (
            m.av_cm_annotate()
          )
        }
      >
        <Button
          size="sm"
          color={annotating ? "secondary" : "tertiary"}
          iconLeading={CursorBox}
          aria-pressed={annotating}
          aria-label={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
          data-annotate-toggle=""
          data-picking={String(annotating)}
          className="min-w-0 shrink *:data-text:min-w-0 *:data-text:truncate"
          onPress={onToggleAnnotate}
        >
          {count > 0 ? (
            <>
              <span className="max-[26rem]:hidden">
                {annotating ? m.av_cm_annotating() : m.av_cm_pick_element()}
              </span>
              <span className="min-[26rem]:hidden">
                {annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
              </span>
            </>
          ) : annotating ? (
            m.av_cm_annotating()
          ) : (
            m.av_cm_pick_element()
          )}
        </Button>
      </Tooltip>
      {count > 0 && (
        <>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border-secondary" />
          <Button
            size="sm"
            color={cardOpen ? "secondary" : "tertiary"}
            iconLeading={MessageSquare01}
            aria-expanded={cardOpen}
            aria-label={`${m.av_dr_group()} (${count})`}
            className="shrink-0"
            onPress={onToggleCard}
          >
            <span className="max-[26rem]:sr-only">{m.av_dr_group()}</span>
            <span
              data-visible="true"
              className="artifact-review-fab-badge ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-brand-secondary px-1 text-xs leading-none font-medium text-brand-secondary tabular-nums max-[26rem]:ms-0"
            >
              {count}
            </span>
          </Button>
          <Tooltip
            title={<TooltipShortcutLabel label={m.av_dr_send_all_tip()} shortcut="Mod+Enter" />}
          >
            <Button
              size="sm"
              color="primary"
              isDisabled={locked}
              data-draft-send=""
              aria-label={m.av_dr_send_all_tip()}
              className="shrink-0"
              onPress={onSubmit}
            >
              {m.av_dr_send_n({ count })}
            </Button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
