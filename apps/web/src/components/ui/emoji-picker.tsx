import { useEffect, useState } from "react";
import { getLocale } from "#src/paraglide/runtime";

import type { EmojiClickData, Theme } from "emoji-picker-react";

/**
 * The one emoji grid: the third-party `emoji-picker-react` (v5), loaded as a real dynamic import —
 * the library and this locale's dataset only reach the browser the first time a caller opens it
 * (the static-import version kept them on the chat route's initial chunk). The visual comes from
 * the app: each epr CSS variable is pinned to the closest app token below the host class, so
 * hover/focus/search/category surfaces read like the rest of the UI, and the theme follows the
 * root `dark-mode` class (see `routes/__root.tsx`'s boot script) rather than the OS one.
 *
 * It renders nothing around itself: the call site composes it with the official `Button` +
 * React Aria `DialogTrigger`/`Popover`/`Dialog`, and owns nullable-value semantics (an optional
 * field renders its own "no emoji" action inside the same `Dialog`, where `Dialog`'s render prop
 * supplies `close`). Used by `features/conversations/chat-section-emoji-picker.tsx`.
 */
export function EmojiPicker({
  searchPlaceholder,
  pickerHostClassName,
  onPick,
}: {
  /** The search input's placeholder, in the call site's locale. */
  searchPlaceholder?: string;
  /** Extra class for the host element that carries the epr token mappings (see styles.css). */
  pickerHostClassName?: string;
  onPick: (emoji: string) => void;
}) {
  const zh = getLocale().startsWith("zh");
  const [libAndData, setLibAndData] = useState<{
    EmojiPicker: typeof import("emoji-picker-react").default;
    data: object;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [epr, data] = await Promise.all([
        import("emoji-picker-react"),
        zh
          ? import("emoji-picker-react/dist/data/emojis-zh")
          : import("emoji-picker-react/dist/data/emojis-en"),
      ]);
      if (alive) setLibAndData({ EmojiPicker: epr.default, data: data.default });
    })();
    return () => {
      alive = false;
    };
  }, [zh]);

  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark-mode");

  return (
    <div
      className={
        pickerHostClassName ?? "min-h-96 *:min-h-96 [data-epr-host] [&_.epr-picker]:border-0"
      }
    >
      {libAndData ? (
        <libAndData.EmojiPicker
          theme={dark ? ("dark" as Theme) : ("light" as Theme)}
          lazyLoadEmojis
          previewConfig={{ showPreview: false }}
          searchPlaceholder={searchPlaceholder ?? (zh ? "搜索表情" : "Search emoji")}
          emojiData={libAndData.data as never}
          onEmojiClick={(emoji: EmojiClickData) => onPick(emoji.emoji)}
        />
      ) : (
        <div className="min-h-96 animate-pulse bg-placeholder" aria-hidden="true" />
      )}
    </div>
  );
}
