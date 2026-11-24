import { AlertCircle } from "@untitledui/icons";

import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { m } from "#src/paraglide/messages";

export function RecordSidePanelEmpty({
  loading,
  failed,
  empty,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  empty: boolean;
  onRetry: () => void;
}) {
  if (!empty) return null;
  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true">
        <div className="h-12 w-5/6 animate-pulse rounded-xl bg-secondary" />
        <div className="ml-auto h-10 w-2/3 animate-pulse rounded-xl bg-secondary" />
      </div>
    );
  }
  if (failed) {
    return (
      <EmptyState
        size="card"
        role="alert"
        picture={<EmptyIcon icon={AlertCircle} size="card" />}
        title={m.empty_records_side_chat_load_failed()}
        primaryAction={<RetryButton size="card" isRetrying={loading} onPress={onRetry} />}
      />
    );
  }
  return <EmptyState size="row" className="px-0" title={m.records_side_chat_empty()} />;
}
