import { Check, FilterLines, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Skeleton } from "#src/components/ui/skeleton";
import { MessageBody } from "#src/features/conversations/message-body";
import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { SECTION_LABEL_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CommentThreadView, type CommentContext } from "./artifact-comment-thread";
import type { ReviewFilter } from "./use-review-filter";

export function ReviewFilterMenu({ filter }: { filter: ReviewFilter }) {
  const name = filter.review?.author.name;
  if (!filter.offered || name === undefined) return null;
  const selected = filter.active ? "review" : "all";
  return (
    <Dropdown.Root>
      <ButtonUtility icon={FilterLines} size="xs" color="tertiary" tooltip={m.av_dr_filter()} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={m.av_dr_filter()}
          selectionMode="single"
          selectedKeys={[selected]}
          onAction={(key) => (key === "review" ? filter.show() : filter.showAll())}
        >
          <Dropdown.Item id="all" label={m.av_dr_filter_all()} />
          <Dropdown.Item id="review" label={m.av_dr_filter_review({ name })} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ReviewChip({ filter }: { filter: ReviewFilter }) {
  const name = filter.review?.author.name;
  if (!filter.active || name === undefined) return null;
  return (
    <span
      data-review-chip=""
      className="mb-3 inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-secondary pl-2 text-xs font-medium text-secondary"
    >
      <Check aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{m.av_dr_filter_review({ name })}</span>
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        tooltip={m.av_dr_filter_clear()}
        onClick={filter.showAll}
      />
    </span>
  );
}

export function ReviewComments({
  filter,
  context,
  plainMentions,
}: {
  filter: ReviewFilter;
  context: CommentContext;
  plainMentions: Map<string, ChipMention> | undefined;
}) {
  const { query, review } = filter;
  if (query.isPending) return <Skeleton aria-busy="true" className="h-16 w-full" />;
  if (query.isError || filter.missing)
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-error-primary">
          {filter.missing ? m.av_dr_review_missing() : m.av_dr_review_failed()}
        </p>
        <div className="flex gap-2">
          {!filter.missing && (
            <Button size="sm" color="secondary" onClick={() => void query.refetch()}>
              {m.av_cm_retry()}
            </Button>
          )}
          <Button size="sm" color="tertiary" onClick={filter.showAll}>
            {m.av_dr_filter_clear()}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3" data-review-comments="">
      {review?.body && (
        <section className="rounded-lg bg-secondary p-3">
          <h3 className={cn(SECTION_LABEL_CLASS, "mb-1")}>{m.av_dr_review_summary()}</h3>
          <div className="message-text text-sm text-primary [overflow-wrap:anywhere]">
            <MessageBody body={review.body} plainMentions={plainMentions} />
          </div>
        </section>
      )}
      <ul className="flex flex-col gap-2">
        {filter.comments.map((comment) => (
          <CommentThreadView
            key={comment.id}
            thread={{ root: comment, replies: [] }}
            context={context}
            versionTag
          />
        ))}
      </ul>
    </div>
  );
}
