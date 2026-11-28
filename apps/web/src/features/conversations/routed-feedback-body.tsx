import { MessageTextSquare01 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { KeyValueList, KeyValueRow } from "#src/components/ui/key-value-list";
import type { FeedbackCategory } from "#src/features/feedback/feedback-types";
import { m } from "#src/paraglide/messages";
import { cn } from "#src/lib/utils";
import { MessageBody } from "./message-body";
import type { MentionRef } from "./mention-text";
import type { RoutedFeedbackMessage } from "./routed-feedback-message";

const EMPTY_MENTIONS: readonly MentionRef[] = [];

const CATEGORY_BADGE_COLORS: Record<FeedbackCategory, "error" | "blue" | "gray"> = {
  bug: "error",
  idea: "blue",
  other: "gray",
};

const AVATAR_SIZE_CLASS = {
  xs: "size-6",
  sm: "size-8",
} as const;

const AVATAR_ICON_CLASS = {
  xs: "size-3.5",
  sm: "size-4",
} as const;

export function routedFeedbackCategoryLabel(category: FeedbackCategory): string {
  switch (category) {
    case "bug":
      return m.feedback_category_bug();
    case "idea":
      return m.feedback_category_idea();
    case "other":
      return m.feedback_category_other();
  }
}

export function RoutedFeedbackAvatar({
  size = "sm",
  className,
}: {
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-secondary text-fg-secondary ring-1 ring-secondary ring-inset",
        AVATAR_SIZE_CLASS[size],
        className,
      )}
    >
      <MessageTextSquare01 className={AVATAR_ICON_CLASS[size]} />
    </span>
  );
}

export function RoutedFeedbackCategoryBadge({ category }: { category: FeedbackCategory }) {
  return (
    <Badge
      type="pill-color"
      size="sm"
      color={CATEGORY_BADGE_COLORS[category]}
      className="shrink-0 self-center"
    >
      {routedFeedbackCategoryLabel(category)}
    </Badge>
  );
}

export function RoutedFeedbackBody({
  feedback,
  showEmailPlain,
}: {
  feedback: RoutedFeedbackMessage;
  showEmailPlain: boolean;
}) {
  const email = showEmailPlain ? feedback.authorEmailDisplay : feedback.authorEmailRaw;
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    {
      label: m.feedback_channel_meta_from(),
      value: email ? `${feedback.authorName} (${email})` : feedback.authorName,
    },
  ];
  if (feedback.workspaceName) {
    rows.push({ label: m.feedback_context_workspace(), value: feedback.workspaceName });
  }
  if (feedback.pagePath) {
    rows.push({ label: m.feedback_context_page(), value: feedback.pagePath, mono: true });
  }
  if (feedback.clientInfo) {
    rows.push({ label: m.feedback_context_client(), value: feedback.clientInfo });
  }
  rows.push({ label: m.feedback_channel_meta_id(), value: feedback.feedbackId, mono: true });

  return (
    <div data-routed-feedback="" className="mt-1 flex min-w-0 flex-col gap-2.5">
      <blockquote className="message-text border-l-2 border-secondary pl-3 text-primary [overflow-wrap:anywhere]">
        <MessageBody body={feedback.quoteMarkdown} mentions={EMPTY_MENTIONS} />
      </blockquote>
      <KeyValueList labelWidth="default" size="sm" className="gap-y-1.5">
        {rows.map((row) => (
          <KeyValueRow
            key={row.label}
            label={row.label}
            mono={row.mono}
            valueClassName={
              row.mono
                ? "text-xs font-normal text-secondary break-all"
                : "font-normal text-secondary"
            }
          >
            {row.value}
          </KeyValueRow>
        ))}
      </KeyValueList>
      <p className="text-xs text-tertiary">{m.feedback_channel_untrusted_footnote()}</p>
    </div>
  );
}
