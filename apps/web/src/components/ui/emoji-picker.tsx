import EmojiPickerReact, { type EmojiClickData, Theme } from "emoji-picker-react";

import zhEmojiData from "emoji-picker-react/dist/data/emojis-zh";
import enEmojiData from "emoji-picker-react/dist/data/emojis-en";
import { getLocale } from "#src/paraglide/runtime";

/**
 * The one emoji grid: the third-party `emoji-picker-react` (v5), themed through the library's own
 * CSS variables to the app's tokens (light theme; the host rounds and rings it), with each
 * locale's localized category dataset and search placeholder. A full picker — search, category
 * tabs, recents, keyboard navigation — in either language, without system-emoji style drift.
 * It renders nothing around itself: the call site composes it with the official `Button` +
 * React Aria `DialogTrigger`/`Popover`/`Dialog`, and owns nullable-value semantics (an optional
 * field renders its own "no emoji" action inside the same `Dialog`, where `Dialog`'s render prop
 * supplies `close`). Used by `features/conversations/chat-section-emoji-picker.tsx`.
 */
export function EmojiPicker({
  searchPlaceholder,
  onPick,
}: {
  onPick: (emoji: string) => void;
  searchPlaceholder?: string;
}) {
  const zh = getLocale().startsWith("zh");
  return (
    <EmojiPickerReact
      theme={Theme.LIGHT}
      lazyLoadEmojis
      searchPlaceholder={searchPlaceholder ?? (zh ? "搜索表情" : "Search emoji")}
      previewConfig={{ showPreview: false }}
      emojiData={(zh ? zhEmojiData : enEmojiData) as never}
      onEmojiClick={(emoji: EmojiClickData) => onPick(emoji.emoji)}
    />
  );
}
