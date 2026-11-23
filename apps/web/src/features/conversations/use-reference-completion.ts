import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { filterMentionables, mentionKey, type Mentionable } from "./mention-text";
import { mentionInsertText } from "./mention-pins";
import {
  activeReferenceQuery,
  filterChannelSuggestions,
  insertReference,
  type ChannelSuggestion,
} from "./reference-completion";

export type ReferenceSuggestion =
  | { kind: "mention"; mention: Mentionable }
  | { kind: "channel"; channel: ChannelSuggestion };

export function mentionCandidates(
  mentionables: readonly Mentionable[] | undefined,
  outsiders: readonly Mentionable[] | undefined,
  query: string,
  recentHandles: readonly string[] | undefined,
): Mentionable[] {
  const memberKeys = new Set((mentionables ?? []).map(mentionKey));
  const members = filterMentionables(
    (mentionables ?? []).filter((item) => !item.unmentionable),
    query,
    { recentHandles },
  );
  return [
    ...members,
    ...filterMentionables(
      (outsiders ?? []).filter((item) => !item.unmentionable && !memberKeys.has(mentionKey(item))),
      query,
      { recentHandles },
    ),
  ];
}

function referenceText(item: ReferenceSuggestion): string {
  return item.kind === "mention" ? mentionInsertText(item.mention) : `#${item.channel.name}`;
}

type ReferenceCandidates = {
  mentionables: readonly Mentionable[] | undefined;
  mentionOutsiders?: readonly Mentionable[] | undefined;
  recentHandles?: readonly string[] | undefined;
  channels?: readonly ChannelSuggestion[] | undefined;
  currentChannelId?: string | undefined;
};

type ActiveReference = NonNullable<ReturnType<typeof activeReferenceQuery>>;

export function useReferenceSuggestions({
  mentionables,
  mentionOutsiders,
  recentHandles,
  channels,
  currentChannelId,
  onChoose,
}: ReferenceCandidates & {
  onChoose: (item: ReferenceSuggestion, query: ActiveReference) => void;
}) {
  const baseId = useId();
  const [query, setQuery] = useState<ActiveReference>();
  const [highlighted, setHighlighted] = useState(0);
  const trackedTextRef = useRef("");
  const dismissedRef = useRef<string | undefined>(undefined);

  const items: ReferenceSuggestion[] = !query
    ? []
    : query.trigger === "@"
      ? mentionCandidates(mentionables, mentionOutsiders, query.query, recentHandles).map(
          (mention) => ({
            kind: "mention",
            mention,
          }),
        )
      : filterChannelSuggestions(channels ?? [], query.query, { currentChannelId }).map(
          (channel) => ({ kind: "channel", channel }),
        );
  const open = items.length > 0;
  const activeIndex = Math.min(highlighted, items.length - 1);

  function track(text: string, caret: number | null) {
    trackedTextRef.current = text;
    if (dismissedRef.current !== undefined && dismissedRef.current !== text)
      dismissedRef.current = undefined;
    setQuery(
      caret === null || dismissedRef.current !== undefined
        ? undefined
        : activeReferenceQuery(text, caret),
    );
    setHighlighted(0);
  }

  function choose(item: ReferenceSuggestion) {
    if (!query) return;
    onChoose(item, query);
    setQuery(undefined);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>, composing?: boolean) {
    if (!open) return false;
    const ime = event.nativeEvent.isComposing || composing;
    if (!ime && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + delta + items.length) % items.length);
      return true;
    }
    if (!ime && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      choose(items[activeIndex]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissedRef.current = trackedTextRef.current;
      setQuery(undefined);
      return true;
    }
    return false;
  }

  return {
    open,
    trigger: open ? query?.trigger : undefined,
    items,
    activeIndex,
    listboxId: `${baseId}-references`,
    optionId: (index: number) => `${baseId}-reference-${index}`,
    track,
    handleKeyDown,
    choose,
    close: () => setQuery(undefined),
    setActiveIndex: setHighlighted,
  };
}

export function useReferenceCompletion({
  value,
  onChange,
  onPickMention,
  ...candidates
}: ReferenceCandidates & {
  value: string;
  onChange: (value: string) => void;
  onPickMention?: (mention: Mentionable) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | undefined>(undefined);
  const suggestions = useReferenceSuggestions({
    ...candidates,
    onChoose(item, query) {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caret = textarea.selectionStart ?? query.start + query.query.length + 1;
      const next = insertReference(value, query.start, caret, referenceText(item));
      pendingCaretRef.current = next.caret;
      if (item.kind === "mention") onPickMention?.(item.mention);
      onChange(next.value);
    },
  });

  useEffect(() => {
    if (pendingCaretRef.current === undefined) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = undefined;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  }, [value]);

  return { ...suggestions, textareaRef };
}
