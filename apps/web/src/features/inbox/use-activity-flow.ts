import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

import {
  hostedConversationOpenParam,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { focusDraftEnd } from "#src/features/conversations/composer-field";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { activityOpenTarget, waitingChoiceTarget } from "./activity-open-target";
import { type ActivityListFlow, waitingRowKey } from "./use-activity-list-keyboard";

/**
 * Activity run from the keyboard while a conversation is open beside the list (`flowing`; Frank,
 * 11-12). The conversation follows the selection the keyboard moves, a moment after the keys stop
 * so a held key does not load every row it passes, nor overrides what was opened meanwhile; a row
 * that opens over the page (a Task's popup, a file's review) is passed by, so the caret stays in
 * the list. Enter on the row the pane shows, or a character typed, goes into the conversation's
 * composer. Undefined while nothing is open beside the list.
 */
export function useActivityFlow({
  flowing,
  rows,
  waiting,
  currentKey,
  pane,
  onOpen,
  composerRef,
}: {
  flowing: boolean;
  rows: readonly ActivityInboxItem[];
  /** The waiting cards shown above the rows. */
  waiting: readonly WaitingChoiceCard[];
  /** The row standing for what the pane shows (`openedItemKey`). */
  currentKey: string | undefined;
  pane: HostedConversationTarget | undefined;
  onOpen: (target: HostedConversationTarget) => void;
  /** The composer the pane hosts (`ComposerHost.composerRef`). */
  composerRef: RefObject<HTMLTextAreaElement | null>;
}): ActivityListFlow | undefined {
  const follow = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Opening another conversation, closing it, or leaving the page drops a follow not yet made.
  // Not the message it is at: a landing clears `msg` once the pane has scrolled to it.
  const paneKey = pane && `${hostedConversationOpenParam(pane)}:${pane.threadRootId ?? ""}`;
  useEffect(() => () => clearTimeout(follow.current), [flowing, paneKey]);

  /** Where the row at `key` opens, and whether the pane shows it already. */
  const rowTarget = useLatestCallback((key: string) => {
    const item = rows.find((candidate) => candidate.key === key);
    if (item) return { target: activityOpenTarget(item), open: key === currentKey };
    const card = waiting.find((candidate) => waitingRowKey(candidate.messageId) === key);
    if (!card) return undefined;
    // A card stands for no inbox item: its conversation or thread being the pane's is enough.
    const target = waitingChoiceTarget(card);
    return { target, open: pane !== undefined && sameOpen(target, pane) };
  });
  const onMove = useLatestCallback((key: string) => {
    clearTimeout(follow.current);
    const target = rowTarget(key)?.target;
    if (!target || target.taskAlone || target.attachmentId !== undefined) return;
    follow.current = setTimeout(() => {
      if (!rowTarget(key)?.open) onOpen(target);
    }, FOLLOW_DELAY_MS);
  });
  // At the draft's end, as opening a conversation puts it; not before the field can take it.
  const onType = useCallback(() => {
    const composer = composerRef.current;
    if (!composer || composer.disabled) return false;
    focusDraftEnd(composer);
    return true;
  }, [composerRef]);
  const onEnter = useLatestCallback((key: string) => rowTarget(key)?.open === true && onType());
  const flow = useMemo(
    () => ({ current: currentKey, onMove, onEnter, onType }),
    [currentKey, onMove, onEnter, onType],
  );
  return flowing ? flow : undefined;
}

/** `target` opens what the pane shows: its conversation, or the same thread alone (rooted at
 * the pane's `msg`). */
function sameOpen(target: HostedConversationTarget, pane: HostedConversationTarget) {
  if (hostedConversationOpenParam(target) !== hostedConversationOpenParam(pane)) return false;
  return !target.threadAlone || target.threadRootId === (pane.threadRootId ?? pane.messageId);
}

/** How long the selection rests before the open conversation follows it. */
const FOLLOW_DELAY_MS = 120;
