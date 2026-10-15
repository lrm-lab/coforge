import { useEffect, useState } from "react";
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
 * block pins the epr variables to the closest app tokens (hover/focus = `bg-secondary_hover`,
 * search field, category labels, skin-tone menu), and the theme follows the root `dark-mode`
 * class (see `routes/__root.tsx`'s boot script), not the OS preference.
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
  loading: "加载中…",
  loadingError: "加载失败",
  retryLoading: "重试",
};

type Epr = typeof import("emoji-picker-react").default;

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
  const [epr, setEpr] = useState<Epr | null>(null);
  const [data, setData] = useState<object | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      try {
        const [eprModule, dataModule] = await Promise.all([
          import("emoji-picker-react"),
          zh
            ? import("emoji-picker-react/dist/data/emojis-zh")
            : import("emoji-picker-react/dist/data/emojis-en"),
        ]);
        if (alive) {
          // TEMP DEBUG
          const Orig = eprModule.default;
          const Wrapped = function (props: never) {
            if (props === null) console.error("[epr-null-props] caller:", new Error().stack?.slice(0, 700));
            return (Orig as (p: never) => unknown)(props);
          };
          setEpr(Wrapped);
          setData(dataModule.default);
        }
      } catch (cause) {
        if (alive) setFailed(true);
        // The chunk request itself is the evidence: a failed import must not stay an unhandled
        // rejection behind the placeholder.
        console.warn("emoji picker failed to load", cause);
      }
    })();
    return () => {
      alive = false;
    };
  }, [zh, attempt]);

  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark-mode");

  return (
    <div
      data-epr-host=""
      className={
        pickerHostClassName ??
        // The pulse placeholder's height is the picker's settled one, so the popover does not
        // jump when the library arrives.
        "min-h-90 *:min-h-90 [&_.epr-picker]:border-0"
      }
    >
      {epr && data ? (
        (() => {
          // Capitalized so JSX renders the component, not a `<epr>` DOM tag.
          const Picker = epr;
          return (
            <Picker
              theme={(dark ? "dark" : "light") as Theme}
              lazyLoadEmojis
              previewConfig={{ showPreview: false }}
              labels={zh ? zhLabels : { searchPlaceholder: "Search emoji" }}
              emojiData={data as never}
              onEmojiClick={(emoji: EmojiClickData) => onPick(emoji.emoji)}
            />
          );
        })()
      ) : failed ? (
        <div className="flex min-h-90 flex-col items-center justify-center gap-2 text-sm text-tertiary">
          <span>{zh ? "加载失败" : "Failed to load"}</span>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="font-medium text-brand-secondary hover:underline"
          >
            {zh ? "重试" : "Retry"}
          </button>
        </div>
      ) : (
        <div className="min-h-90 animate-pulse bg-secondary" aria-hidden="true" />
      )}
    </div>
  );
}
