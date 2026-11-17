import { AlertCircle, XClose } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";

/**
 * A one-line notice above the composer's field, in its quiet tertiary text with a warning icon,
 * and a close button. The composer keeps an always-mounted `role="status"` copy of the text for
 * screen readers, so this visual line is hidden from them.
 */
export function ComposerNotice({
  text,
  dismissLabel,
  onDismiss,
}: {
  text: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 px-2 text-sm text-tertiary">
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-warning-primary" />
      <p aria-hidden="true" className="min-w-0 flex-1">
        {text}
      </p>
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        tooltip={dismissLabel}
        onClick={onDismiss}
      />
    </div>
  );
}
