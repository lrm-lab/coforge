import { useId } from "react";
import { ChevronDown, FolderPlus } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { EmojiPicker } from "#src/components/ui/emoji-picker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** A new section starts with this mark, so it reads as a folder before the member picks one. */
export const DEFAULT_SECTION_EMOJI = "📁";

/**
 * The section dialog's emoji field: a button showing the current mark (a folder-plus glyph and
 * "No emoji" when there is none) that opens the shared `EmojiPicker`, or clears from the action
 * under the grid. The button and popover are the official Button and React Aria, as the message
 * reaction picker builds theirs.
 */
export function ChatSectionEmojiPicker({
  value,
  onChange,
  isDisabled,
}: {
  value: string | null;
  onChange: (emoji: string | null) => void;
  isDisabled?: boolean;
}) {
  const labelId = useId();
  const label = m.chat_section_emoji();
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-secondary">
        {label}
      </span>
      <DialogTrigger>
        <Button
          color="secondary"
          size="md"
          isDisabled={isDisabled}
          aria-labelledby={labelId}
          aria-description={value ?? m.chat_section_emoji_none()}
          iconLeading={value ? undefined : FolderPlus}
          iconTrailing={ChevronDown}
          className={cx("w-24 justify-between", value && "px-3")}
        >
          {value ? (
            <span aria-hidden="true" className="inline-block align-top text-lg/5">
              {value}
            </span>
          ) : (
            <span className="text-placeholder">{m.chat_section_emoji_none()}</span>
          )}
        </Button>
        <AriaPopover
          placement="bottom start"
          offset={6}
          className="max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
        >
          <Dialog aria-label={label} className="outline-none">
            {({ close }) => (
              <div className="w-88 max-w-[calc(100vw-1rem)]">
                <EmojiPicker
                  onPick={(emoji) => {
                    onChange(emoji);
                    close();
                  }}
                />
                {/* The grid has no "none"; a section keeps its no-mark option here. */}
                <div className="border-t border-secondary_alt p-2">
                  <Button
                    color="link-gray"
                    size="sm"
                    onPress={() => {
                      onChange(null);
                      close();
                    }}
                  >
                    {m.chat_section_emoji_none()}
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </AriaPopover>
      </DialogTrigger>
    </div>
  );
}
