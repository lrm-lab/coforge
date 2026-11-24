import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import type { EmojiClickData, PickerLabels, Theme } from "emoji-picker-react";

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

type Library = {
  picker: typeof import("emoji-picker-react").default;
  data: object;
};

export function EmojiPicker({
  pickerHostClassName,
  onPick,
}: {
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
      } catch {
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
        width="100%"
        lazyLoadEmojis
        previewConfig={{ showPreview: false }}
        labels={zh ? zhLabels : { searchPlaceholder: "Search emoji" }}
        emojiData={data as never}
        onEmojiClick={(emoji: EmojiClickData) => onPick(emoji.emoji)}
      />
    );
  } else if (failed) {
    const exhausted = attempt > 0;
    grid = (
      <div className="flex min-h-90 items-center justify-center p-4">
        <EmptyState
          size="page"
          picture={<EmptyIcon icon={AlertCircle} />}
          title={m.empty_emoji_load_failed()}
          description={m.empty_load_failed_safe()}
          primaryAction={
            exhausted ? (
              <Button color="secondary" size="sm" onPress={() => window.location.reload()}>
                {m.empty_emoji_reload()}
              </Button>
            ) : (
              <RetryButton onPress={() => setAttempt((n) => n + 1)} />
            )
          }
        />
      </div>
    );
  } else {
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
