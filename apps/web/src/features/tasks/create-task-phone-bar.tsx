import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

/**
 * The New task page's top bar on a phone (task #54): Cancel, what this page is, Create. The keyboard
 * takes the bottom of the screen while the title is typed, so the action that ends the page sits at
 * its top, a filled button as on desktop; the chips stay at the bottom, right above the keyboard.
 * Each control's hit area reaches 44px, the bar's height. Create submits the form without being its
 * submit button: the form keeps one, the desktop footer's, which Enter presses.
 */
export function CreateTaskPhoneBar({
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
