import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { COMPOSER_FRAME_CLASS } from "./composer-frame";
import { MessageSkeleton } from "./message-skeleton";
import { ConversationBackHeader } from "./conversation-list-button";

/**
 * The loading screen Chat shows until its lists and the open conversation have been read in the
 * browser: the frame `ConversationNavigation` draws (the list column from a desktop width, the
 * conversation beside it), with skeletons where the rows will be. It is also what the server
 * sends for a Chat page.
 */
export function MessagesPending() {
  return (
    <main
      data-panel-cards
      className="flex h-full min-w-0 flex-col bg-primary lg:flex-row lg:gap-2 lg:bg-transparent"
    >
      <section className="hidden min-h-0 flex-col lg:flex lg:w-72 lg:flex-none lg:overflow-hidden lg:rounded-xl lg:bg-primary">
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden lg:rounded-xl lg:bg-primary">
        <ConversationPending />
      </div>
    </main>
  );
}

/** The open conversation's loading screen: its header, message skeletons and composer frame. */
export function ConversationPending({ label = m.conversation_loading() }: { label?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationBackHeader>
        <p role="status" className="sr-only">
          {label}
        </p>
      </ConversationBackHeader>
      <div
        aria-busy="true"
        aria-label={m.conversation_history()}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {/* The same reading column as the loaded stream, so rows do not jump sideways on load. */}
        <div
          aria-hidden="true"
          className={`${MESSAGE_COLUMN_CLASS} pt-6 motion-safe:animate-pulse`}
        >
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <MessageSkeleton key={width} width={width} />
          ))}
        </div>
      </div>
      {/* The composer's frame, in the same column as the stream above, around one row as tall as
          its buttons. */}
      <div className={MESSAGE_COLUMN_CLASS}>
        <div aria-hidden="true" className={COMPOSER_FRAME_CLASS}>
          <div className="h-8" />
        </div>
      </div>
    </div>
  );
}
