import { AlertCircle } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { MessageSkeleton } from "./message-skeleton";
import { ThreadPaneHeader } from "./thread-pane-header";

/**
 * Where a thread stands while what its pane shows is not loaded: the thread slot shows it in place
 * of the thread (docs/design/toast-vs-inline.md — what the viewer must see stays in the affected
 * area). `loading` while it is read; `missing` when the channel has no such first message (deleted,
 * or a link to a message that never started a thread); `failed` when the read itself failed. It is
 * the state of a thread opened by link whose first message is not loaded, and of a thread whose
 * replies are being read (`ThreadPane`).
 */
export type ThreadRootLoad =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; errorId?: string };

/**
 * The thread while it is read, drawn as the loaded pane draws it: the first message over its rule,
 * the line that counts the replies, and replies under it, each where `ConversationPane` puts it, so
 * the thread replaces it without a jump. `withRoot` is false where something else stands for the
 * first message (the Task popup shows the Task).
 */
function ThreadSkeleton({ withRoot }: { withRoot: boolean }) {
  return (
    <div role="status" aria-label={m.conversation_loading()} className="min-h-0 overflow-hidden">
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        {withRoot && (
          <div className="border-b border-secondary py-3">
            <MessageSkeleton width="w-3/4" />
          </div>
        )}
        <div className="message-text px-4 pt-2 text-md md:px-6">
          <div className="flex h-6 items-center justify-center pb-1">
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex h-8 items-center justify-center border-b border-secondary pb-2">
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <div className="pt-2">
          {["w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <MessageSkeleton key={width} width={width} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The thread's state on its own, for a pane that draws its own header (or none, in a popup). */
export function ThreadLoadStatus({
  load,
  withRoot = true,
  onClose,
  onRetry,
}: {
  load: ThreadRootLoad;
  /** Whether the loading thread draws its first message; see `ThreadSkeleton`. */
  withRoot?: boolean;
  /** Leaves the thread; a thread that is gone offers it as the way out. */
  onClose?: () => void;
  onRetry: () => void;
}) {
  return load.status === "loading" ? (
    <ThreadSkeleton withRoot={withRoot} />
  ) : (
    <div className="grid justify-items-center gap-4 px-4 py-8 text-center md:px-6">
      <AlertCircle aria-hidden="true" className="size-5 text-error-primary" />
      <p role="alert" className="text-sm">
        {load.status === "missing"
          ? m.conversation_thread_unavailable()
          : m.conversation_thread_load_error()}
      </p>
      {load.status === "failed" && load.errorId && (
        <p className="text-xs text-tertiary">{m.error_reference({ errorId: load.errorId })}</p>
      )}
      {load.status === "failed" ? (
        <Button color="secondary" onPress={onRetry}>
          {m.controls_retry()}
        </Button>
      ) : (
        onClose && (
          <Button color="secondary" onPress={onClose}>
            {m.conversation_thread_close()}
          </Button>
        )
      )}
    </div>
  );
}

export function ThreadRootState({
  load,
  context,
  onClose,
  onRetry,
}: {
  load: ThreadRootLoad;
  context?: string;
  onClose?: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadPaneHeader context={context} onClose={onClose} />
      <ThreadLoadStatus load={load} onClose={onClose} onRetry={onRetry} />
    </div>
  );
}
