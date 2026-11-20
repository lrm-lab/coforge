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

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
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
        "inline-flex max-w-48 items-center gap-1 rounded-md bg-utility-orange-50 px-1.5 py-0.5 font-mono text-xs font-medium text-utility-orange-700",
        className,
      )}
    >
      <Cursor02 aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {onRemove && (
        <AriaButton
          aria-label={m.controls_cancel()}
          onPress={onRemove}
          className="ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-utility-orange-700/75 transition-colors hover:text-utility-orange-700"
        >
          <XClose className="size-2.5" />
        </AriaButton>
      )}
    </span>
  );
}

export function KbdHint({
  children,
  tone = "secondary",
}: {
  children: string;
  tone?: "secondary" | "primary";
}) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "rounded-sm px-1 py-0.5 font-mono text-xs leading-none font-medium",
        tone === "primary"
          ? "bg-alpha-white/15 text-alpha-white/85"
          : "border border-secondary bg-primary/80 text-tertiary",
      )}
    >
      {children}
    </kbd>
  );
}

export function TooltipWithKey({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <>
      {label}
      <kbd className="ml-2 rounded-xs px-1 font-sans text-xs font-medium text-tooltip-supporting-text ring-1 ring-current ring-inset">
        {shortcut}
      </kbd>
    </>
  );
}

export function ArtifactReviewQueue({
  drafts,
  focusedIdx,
  locked,
  atLimit,
  modEnter,
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
  modEnter: string;
  onOpenDraft: (draft: CommentDraftView) => void;
  onEditDraft: (draft: CommentDraftView) => void;
  onRemoveDraft: (draft: CommentDraftView) => void;
  onNewComment: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <ul className="max-h-60 divide-y divide-secondary overflow-y-auto">
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
              className="min-w-0 flex-1 cursor-pointer text-left text-sm leading-relaxed text-primary outline-focus-ring focus-visible:outline-2"
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
              <ButtonUtility
                icon={Trash01}
                size="xs"
                color="tertiary"
                tooltip={m.av_cm_delete()}
                tooltipShortcut="⌫"
                isDisabled={locked}
                onClick={() => onRemoveDraft(draft)}
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-secondary px-3.5 py-2.5">
        <CoForgeMark className="h-4 shrink-0 opacity-85" />
        <div className="flex items-center gap-2">
          <AriaButton
            isDisabled={locked || atLimit}
            onPress={onNewComment}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-secondary bg-secondary px-3 py-1.5 text-xs font-medium text-primary outline-focus-ring transition-colors hover:bg-secondary_hover focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            <span>{m.av_dr_new_comment()}</span>
            <KbdHint>N</KbdHint>
          </AriaButton>
          <Tooltip title={<TooltipWithKey label={m.av_dr_send_all_tip()} shortcut={modEnter} />}>
            <AriaButton
              isDisabled={locked}
              data-draft-send=""
              aria-label={m.av_dr_send_all_tip()}
              onPress={onSubmit}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-alpha-black px-3.5 py-1.5 text-xs font-semibold text-alpha-white ring-1 ring-alpha-black ring-offset-2 ring-offset-primary outline-focus-ring transition-opacity hover:opacity-90 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>{m.av_dr_send_all()}</span>
              <KbdHint tone="primary">{modEnter}</KbdHint>
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </AriaButton>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

export function ArtifactReviewFab({
  annotating,
  count,
  onPress,
}: {
  annotating: boolean;
  count: number;
  onPress: () => void;
}) {
  return (
    <Tooltip
      title={
        <TooltipWithKey
          label={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
          shortcut={annotating ? "Esc" : "C"}
        />
      }
    >
      <AriaButton
        aria-pressed={annotating}
        aria-label={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
        data-annotate-toggle=""
        data-picking={String(annotating)}
        onPress={onPress}
        className={cn(
          "artifact-review-fab pointer-events-auto relative flex size-11 cursor-pointer items-center justify-center rounded-full shadow-lg outline-focus-ring focus-visible:outline-2",
          annotating
            ? "border-2 border-utility-orange-500 bg-terminal text-utility-orange-500"
            : "border border-secondary/30 bg-terminal text-terminal-fg",
        )}
      >
        <span aria-hidden="true" className="artifact-review-fab-icon artifact-review-fab-bubble">
          <MessageSquare01 className="size-5" />
        </span>
        <span aria-hidden="true" className="artifact-review-fab-icon artifact-review-fab-pick">
          <CursorBox className="size-5" />
        </span>
        <span
          aria-hidden="true"
          data-visible={String(count > 0 && !annotating)}
          className="artifact-review-fab-badge pointer-events-none absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-utility-orange-500 px-1 text-xs leading-none font-semibold text-white tabular-nums shadow-xs"
        >
          {count}
        </span>
      </AriaButton>
    </Tooltip>
  );
}
