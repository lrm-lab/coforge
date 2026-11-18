import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export function PhoneFormBar({
  heading,
  submitLabel,
  pending,
  submitDisabled,
  cancelDisabled = pending,
  onCancel,
  onSubmit,
  className,
}: {
  heading: string;
  submitLabel?: string;
  pending: boolean;
  submitDisabled?: boolean;
  cancelDisabled?: boolean;
  onCancel: () => void;
  onSubmit?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:hidden",
        className,
      )}
    >
      <Button
        color="link-gray"
        size="md"
        isDisabled={cancelDisabled}
        onClick={onCancel}
        className="h-11 justify-self-start after:absolute after:-inset-x-2 after:inset-y-0"
      >
        {m.controls_cancel()}
      </Button>
      <span aria-hidden="true" className="truncate text-md font-semibold text-primary">
        {heading}
      </span>
      {submitLabel && (
        <Button
          size="sm"
          isLoading={pending}
          isDisabled={submitDisabled}
          onClick={onSubmit}
          className="justify-self-end after:absolute after:-inset-y-1 after:inset-x-0"
        >
          {submitLabel}
        </Button>
      )}
    </div>
  );
}
