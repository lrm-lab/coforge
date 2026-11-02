import { Button } from "#src/components/base/buttons/button";
import { Alert, type AlertColor } from "#src/components/ui/alert";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";

/** A read of the Computer in flight. */
export function HandoffProgress({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-6 text-sm text-tertiary"
    >
      <Spinner className="size-4" />
      {label}
    </div>
  );
}

/** A read of the Computer that gave no answer to use, with Retry when asking again may help. */
export function HandoffRefusal({
  color,
  text,
  onRetry,
}: {
  color: AlertColor;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      color={color}
      description={text}
      actions={
        onRetry && (
          <Button color="secondary" size="sm" onPress={onRetry}>
            {m.handoff_retry()}
          </Button>
        )
      }
    />
  );
}
