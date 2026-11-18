import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

export function PhoneFormBar({
  heading,
  saving,
  onCancel,
  onCreate,
}: {
  heading: string;
  saving: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:hidden">
      <Button
        color="link-gray"
        size="md"
        isDisabled={saving}
        onClick={onCancel}
        className="h-11 justify-self-start after:absolute after:-inset-x-2 after:inset-y-0"
      >
        {m.tasks_create_cancel()}
      </Button>
      <span className="truncate text-md font-semibold text-primary">{heading}</span>
      <Button
        size="sm"
        isLoading={saving}
        onClick={onCreate}
        className="justify-self-end after:absolute after:-inset-y-1 after:inset-x-0"
      >
        {m.tasks_create_submit_short()}
      </Button>
    </div>
  );
}
