import { PageHeader } from "#src/components/layout/page-header";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { COMPOSER_FRAME_CLASS } from "./composer-frame";
import { MessageSkeleton } from "./message-skeleton";
import { ConversationBackHeader, ConversationListButton } from "./conversation-list-button";
import { LIST_COLUMN_CLASS } from "./conversation-list-width";
import { useStandaloneThread } from "./standalone-thread";
import { cx } from "#src/utils/cx";

export function MessagesPending() {
  return (
    <main className="flex h-full min-w-0 flex-col bg-primary lg:flex-row">
      <section
        className={cx(
          "hidden min-h-0 flex-col bg-primary lg:flex lg:flex-none lg:border-e lg:border-secondary",
          LIST_COLUMN_CLASS,
        )}
      >
        <PageHeader heading={m.navigation_chat()} />
        <div
          aria-hidden="true"
          className="min-h-0 flex-1 space-y-6 overflow-hidden px-6 py-4 motion-safe:animate-pulse"
        >
          {[
            ["w-24", "w-32", "w-20", "w-28"],
            ["w-28", "w-24", "w-32"],
          ].map((widths, group) => (
            <div key={group} className="space-y-3">
              <Skeleton className="h-2.5 w-16" />
              {widths.map((width) => (
                <div key={width} className="flex items-center gap-3">
                  <Skeleton className="size-5 shrink-0" />
                  <Skeleton className={`h-3 ${width}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary">
        <ConversationPending />
      </div>
    </main>
  );
}

export function ConversationPending({ label = m.conversation_loading() }: { label?: string }) {
  const standaloneThread = useStandaloneThread();
  const status = (
    <p role="status" className="sr-only">
      {label}
    </p>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {standaloneThread ? (
        <ConversationBackHeader>{status}</ConversationBackHeader>
      ) : (
        <TabbedHeader
          identity={
            <>
              <ConversationListButton />
              {status}
            </>
          }
          tabs={<div aria-hidden="true" className="h-8" />}
        />
      )}
      <div
        aria-busy="true"
        aria-label={m.conversation_history()}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <div
          aria-hidden="true"
          className={`${MESSAGE_COLUMN_CLASS} pt-6 motion-safe:animate-pulse`}
        >
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <MessageSkeleton key={width} width={width} />
          ))}
        </div>
      </div>
      <div className={MESSAGE_COLUMN_CLASS}>
        <div aria-hidden="true" className={COMPOSER_FRAME_CLASS}>
          <div className="h-8" />
        </div>
      </div>
    </div>
  );
}
