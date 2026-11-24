import { AlertCircle } from "@untitledui/icons";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { m } from "#src/paraglide/messages";

export function PanelMessage({
  text,
  alert = false,
  onRetry,
}: {
  text: string;
  alert?: boolean;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      role={alert || onRetry ? "alert" : undefined}
      picture={<EmptyIcon icon={AlertCircle} muted={!alert && !onRetry} />}
      title={text}
      description={alert || onRetry ? m.empty_load_failed_safe() : undefined}
      primaryAction={
        onRetry ? <RetryButton label={m.agent_workspace_retry()} onPress={onRetry} /> : undefined
      }
    />
  );
}
