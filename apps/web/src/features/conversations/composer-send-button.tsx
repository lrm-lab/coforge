import { CheckSquare, ChevronDown, Send01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { hotkeyLabel } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

const NEAR_BLACK_NOT_BRAND_VIOLET_SEND_CLASS =
  "bg-primary-solid hover:bg-primary-solid data-loading:bg-primary-solid dark:bg-secondary-solid dark:hover:bg-secondary-solid dark:data-loading:bg-secondary-solid *:data-icon:text-white hover:*:data-icon:text-white";

const MENU_OFFSET_CLEARING_COMPOSER_PADDING_AND_BORDER = 17;

const SPLIT_HALF_OVERLAPS_ONE_PIXEL_WITH_NO_SEAM_HIGHLIGHT =
  "-ml-px rounded-l-none before:rounded-l-none before:border-l-0";

export function ComposerSendButton({
  asTask,
  taskMode,
  isDisabled,
  onChoose,
  label: labelOverride,
  className,
}: {
  label?: string;
  asTask: boolean;
  taskMode: boolean;
  isDisabled: boolean;
  onChoose: (asTask: boolean) => void;
  className?: string;
}) {
  const sendAsTaskBindings = useShortcutBindings("sendAsTask");
  const sendAsTaskShortcut = sendAsTaskBindings[0];
  const label = labelOverride ?? (asTask ? m.conversation_send_as_task() : m.conversation_send());
  const other = asTask
    ? { label: m.conversation_send(), description: m.conversation_send_plain_description() }
    : {
        label: m.conversation_send_as_task(),
        description: m.conversation_send_as_task_description(),
        shortcut: sendAsTaskShortcut
          ? hotkeyLabel(sendAsTaskShortcut, isApplePlatform())
          : undefined,
      };
  const look = isDisabled
    ? ({ color: "secondary" } as const)
    : ({ color: "primary", className: NEAR_BLACK_NOT_BRAND_VIOLET_SEND_CLASS } as const);
  return (
    <div className={cx("flex items-center", className)}>
      <Tooltip title={label} isDisabled={isDisabled}>
        <Button
          type="submit"
          color={look.color}
          size="xs"
          iconLeading={asTask ? CheckSquare : Send01}
          aria-label={label}
          className={cx(
            look.className,
            taskMode && "rounded-r-none before:rounded-r-none before:border-r-0",
          )}
          isDisabled={isDisabled}
        />
      </Tooltip>
      {taskMode && (
        <Dropdown.Root>
          <Tooltip title={m.conversation_send_options()} isDisabled={isDisabled}>
            <Button
              color={look.color}
              size="xs"
              iconLeading={ChevronDown}
              aria-label={m.conversation_send_options()}
              className={cx(look.className, SPLIT_HALF_OVERLAPS_ONE_PIXEL_WITH_NO_SEAM_HIGHLIGHT)}
              isDisabled={isDisabled}
            />
          </Tooltip>
          <Dropdown.Popover
            placement="top end"
            offset={MENU_OFFSET_CLEARING_COMPOSER_PADDING_AND_BORDER}
            className="w-64"
          >
            <Dropdown.Menu
              aria-label={m.conversation_send_options()}
              onAction={() => onChoose(!asTask)}
            >
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
