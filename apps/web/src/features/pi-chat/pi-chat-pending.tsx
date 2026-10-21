import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";

export function PiChatPending() {
  return (
    <main aria-busy="true" className="flex h-full min-h-0 flex-col gap-4 p-page">
      <p role="status" className="text-sm text-tertiary">
        {m.pi_chat_loading()}
      </p>
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-24 w-full" />
    </main>
  );
}
