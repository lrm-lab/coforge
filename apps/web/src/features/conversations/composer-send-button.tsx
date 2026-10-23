import { CheckSquare, ChevronDown, Send01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** The send buttons are near-black (neutral-600 in dark mode, where near-black sinks into the background), not the primary button's brand violet, with white icons instead of the dimmed default. */
const SEND_BUTTON_CLASS =
  "bg-primary-solid hover:bg-primary-solid data-loading:bg-primary-solid dark:bg-secondary-solid dark:hover:bg-secondary-solid dark:data-loading:bg-secondary-solid *:data-icon:text-white hover:*:data-icon:text-white";

/**
 * The composer's submit button. With `taskMode` it is split: a chevron beside it opens a menu
 * holding the other send, as a Task or as a plain message (sending as a Task has the keyboard twin
 * Cmd/Ctrl+Shift+Enter), so the one-line row has no room-taking toggle. The two halves overlap by
 * a pixel and drop their seam-side inner highlight, so they read as one button with a single
 * hairline between them.
 */
export function ComposerSendButton({
  asTask,
  taskMode,
  isDisabled,
  onChoose,
  className,
}: {
  /** Whether a plain send (the button, Enter) goes out as a Task: an edited-back Task. */
  asTask: boolean;
  taskMode: boolean;
  isDisabled: boolean;
  /** The menu's send: now, as a Task or not, whichever the button itself does not. */
  onChoose: (asTask: boolean) => void;
  className?: string;
}) {
  const label = asTask ? m.conversation_send_as_task() : m.conversation_send();
  const other = asTask
    ? { label: m.conversation_send(), description: m.conversation_send_plain_description() }
    : {
        label: m.conversation_send_as_task(),
        description: m.conversation_send_as_task_description(),
        shortcut: isApplePlatform() ? "⌘⇧Enter" : "Ctrl+Shift+Enter",
      };
  return (
    <div className={cx("flex items-center", className)}>
      <Tooltip title={label} isDisabled={isDisabled}>
        <Button
          type="submit"
          color="primary"
          size="xs"
          iconLeading={asTask ? CheckSquare : Send01}
          aria-label={label}
          className={cx(
            SEND_BUTTON_CLASS,
            taskMode && "rounded-r-none before:rounded-r-none before:border-r-0",
          )}
          isDisabled={isDisabled}
        />
      </Tooltip>
      {taskMode && (
        <Dropdown.Root>
          <Tooltip title={m.conversation_send_options()} isDisabled={isDisabled}>
            <Button
              color="primary"
              size="xs"
              iconLeading={ChevronDown}
              aria-label={m.conversation_send_options()}
              className={cx(
                SEND_BUTTON_CLASS,
                "-ml-px rounded-l-none before:rounded-l-none before:border-l-0",
              )}
              isDisabled={isDisabled}
            />
          </Tooltip>
          {/* The offset clears the composer's padding and border, so the menu sits above the
              composer instead of on its edge. */}
          <Dropdown.Popover placement="top end" offset={17} className="w-64">
            <Dropdown.Menu
              aria-label={m.conversation_send_options()}
              onAction={() => onChoose(!asTask)}
            >
              {/* Only the other send, as a split button's menu offers: it runs once and leaves the
                  button's own send as it was. An edited-back Task's other send has no shortcut. The
                  popover renders only in the browser, where the platform is known. */}
              <Dropdown.Item id={asTask ? "send" : "task"} textValue={other.label}>
                <span className="flex items-baseline justify-between gap-3">
                  {other.label}
                  {other.shortcut && (
                    <span className="text-xs font-medium text-quaternary">{other.shortcut}</span>
                  )}
                </span>
                <span className="block text-xs font-normal whitespace-normal text-tertiary">
                  {other.description}
                </span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
    </div>
  );
}
