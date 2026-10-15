import { useId } from "react";
import { ChevronDown } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";

/** A new section starts with this mark, so it reads as a folder before the member picks one. */
export const DEFAULT_SECTION_EMOJI = "📁";

/** The marks a section can carry. Each is one emoji grapheme, as `chatSectionFields` requires;
 * a section saved with another one (from before this picker) keeps it until it is changed. */
export const SECTION_EMOJIS = [
  "📁",
  "📂",
  "🗂️",
  "📌",
  "⭐",
  "🔥",
  "🚀",
  "🎯",
  "💡",
  "🧪",
  "🛠️",
  "🐛",
  "📣",
  "💬",
  "🤖",
  "👥",
  "🏠",
  "📚",
  "📝",
  "✅",
  "🎨",
  "💼",
  "🌱",
  "⚡",
  "🔒",
  "📦",
  "🧭",
  "🏁",
  "🎉",
  "❤️",
  "👀",
  "🌍",
] as const;

/**
 * The section dialog's emoji field: a button showing the current mark that opens a grid to pick
 * another, or none. Built from the official Button and React Aria's Popover/Dialog, as the
 * message reaction picker is; the grid is a group of buttons, so it is reachable by Tab and each
 * mark is announced by its own character.
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
          iconTrailing={ChevronDown}
          // `md` is the Name input's height (both 2.5rem); height comes from `size` alone.
          className="w-24 justify-between"
        >
          <span aria-hidden="true" className="inline-block align-top text-lg/5">
            {value ?? "—"}
          </span>
        </Button>
        <AriaPopover
          placement="bottom start"
          offset={6}
          className="rounded-xl bg-primary p-2 shadow-lg ring-1 ring-secondary_alt outline-none"
        >
          <Dialog aria-label={label} className="outline-none">
            {({ close }) => (
              <div className="flex flex-col gap-1">
                <div role="group" aria-label={label} className="grid grid-cols-8 gap-0.5">
                  {SECTION_EMOJIS.map((emoji) => (
                    <Button
                      key={emoji}
                      color="tertiary"
                      size="sm"
                      aria-pressed={emoji === value}
                      onPress={() => {
                        onChange(emoji);
                        close();
                      }}
                      className={cx(emoji === value && "bg-active")}
                    >
                      {/* A larger glyph on the button's own 1.25rem line, so the height stays
                          the `sm` size's. */}
                      <span className="inline-block align-top text-lg/5">{emoji}</span>
                    </Button>
                  ))}
                </div>
                <Button
                  color="link-gray"
                  size="sm"
                  onPress={() => {
                    onChange(null);
                    close();
                  }}
                  className="self-start px-1"
                >
                  {m.chat_section_emoji_none()}
                </Button>
              </div>
            )}
          </Dialog>
        </AriaPopover>
      </DialogTrigger>
    </div>
  );
}
