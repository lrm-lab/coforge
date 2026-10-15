import { useEffect, useState, type ReactNode } from "react";

import { Button } from "#src/components/base/buttons/button";
import { getLocale } from "#src/paraglide/runtime";

import type { EmojiClickData, PickerLabels, Theme } from "emoji-picker-react";

/**
 * The one emoji grid: the third-party `emoji-picker-react` (v5), loaded as a real dynamic import —
 * the library and this locale's dataset only reach the browser the first time a caller opens it
 * (a static import would ship both on the chat route's preloaded chunk; see Task #199's perf
 * review). Until it resolves, and again if the import fails, the host shows a matching-sized
 * placeholder with a retry action, so a flaky chunk request reads as the app's loading state, not
 * a broken popover.
 *
 * The visuals come from the app: the host element carries `data-epr-host`, whose `styles.css`
 * block pins the epr variables to the app's tokens (hover/focus/search/category surfaces), and
 * the theme follows the root `dark-mode` class (see `routes/__root.tsx`'s boot script), not the
 * OS preference.
 *
 * It renders nothing around itself: the call site composes it with the official `Button` +
 * React Aria `DialogTrigger`/`Popover`/`Dialog`, and owns nullable-value semantics (an optional
 * field renders its own "no emoji" action inside the same `Dialog`, where `Dialog`'s render prop
 * supplies `close`). Used by `features/conversations/chat-section-emoji-picker.tsx`.
 */

/** Every user-facing string in the app's language; omitted keys keep the English defaults, so
 * English call sites pass only the placeholder. */
const zhLabels: Partial<PickerLabels> = {
  searchPlaceholder: "搜索表情",
  searchLabel: "搜索表情",
  searchClear: "清除搜索",
  searchResultsNone: "没有结果",
  searchResultsOne: "找到 1 个结果",
  searchResultsMany: "找到 %n 个结果",
  categoryNavigation: "表情分类导航",
  skinToneNeutral: "无肤色",
  skinToneLight: "浅肤色",
  skinToneMediumLight: "中等偏浅肤色",
  skinToneMedium: "中等肤色",
  skinToneMediumDark: "中等偏深肤色",
  skinToneDark: "深肤色",
  loading: "加载中…",
  loadingError: "加载失败",
  retryLoading: "重试",
};

/** One state, not two: a function-sized state would be read by React as a lazy initializer /
 * updater and called with the previous state, which never are the picker's props. */
type Library = {
  picker: typeof import("emoji-picker-react").default;
  data: object;
};

export function EmojiPicker({
  pickerHostClassName,
  onPick,
}: {
  /** Extra class for the host element, alongside its `data-epr-host` attribute. */
  pickerHostClassName?: string;
  onPick: (emoji: string) => void;
}) {
  const zh = getLocale().startsWith("zh");
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      try {
        const [epr, data] = await Promise.all([
          import("emoji-picker-react"),
          zh
            ? import("emoji-picker-react/dist/data/emojis-zh")
            : import("emoji-picker-react/dist/data/emojis-en"),
        ]);
        if (alive) setLibrary({ picker: epr.default, data: data.default });
      } catch (cause) {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [zh, attempt]);

  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark-mode");

  let grid: ReactNode;
  if (library) {
    const { picker: Picker, data } = library;
    grid = (
      <Picker
        theme={(dark ? "dark" : "light") as Theme}
        // `width: 100%`: the picker's own mount sizing hardcodes a 350px inline width; filling
        // the host lets the host's own max-width (call site) or the narrow-screen tokens below
        // (styles.css) decide the real width.
        width="100%"
        lazyLoadEmojis
        previewConfig={{ showPreview: false }}
        labels={zh ? zhLabels : { searchPlaceholder: "Search emoji" }}
        emojiData={data as never}
        onEmojiClick={(emoji: EmojiClickData) => onPick(emoji.emoji)}
      />
    );
  } else if (failed) {
    // A module URL whose fetch failed is remembered by the document, so a second import() of the
    // same URL cannot recover — the first retry is an honest second attempt, and after it the
    // only real recovery is a fresh document load.
    const exhausted = attempt > 0;
    grid = (
      <div className="flex min-h-90 flex-col items-center justify-center gap-2 text-sm text-tertiary">
        <span>{zh ? "加载失败" : "Failed to load"}</span>
        {exhausted ? (
          <Button color="link-gray" size="sm" onPress={() => window.location.reload()}>
            {zh ? "刷新页面" : "Reload page"}
          </Button>
        ) : (
          <Button color="link-gray" size="sm" onPress={() => setAttempt((n) => n + 1)}>
            {zh ? "重试" : "Retry"}
          </Button>
        )}
      </div>
    );
  } else {
    // The placeholder's height is the picker's settled one, so the popover does not jump when
    // the library arrives.
    grid = <div className="min-h-90 animate-pulse bg-secondary" aria-hidden="true" />;
  }

  return (
    <div
      data-epr-host=""
      className={pickerHostClassName ?? "min-h-90 *:min-h-90 [&_.epr-picker]:border-0"}
    >
      {grid}
    </div>
  );
}
