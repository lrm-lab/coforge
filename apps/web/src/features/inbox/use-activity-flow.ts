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
  waiting: readonly WaitingChoiceCard[];
  currentKey: string | undefined;
  pane: HostedConversationTarget | undefined;
  onOpen: (target: HostedConversationTarget) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}): ActivityListFlow | undefined {
  const follow = useRef<ReturnType<typeof setTimeout>>(undefined);
  const paneKey =
    pane && `${hostedConversationOpenParam(pane)}:${pane.threadRootId ?? ""}:${pane.task ?? ""}`;
  useEffect(() => () => clearTimeout(follow.current), [flowing, paneKey]);

  const rowTarget = useLatestCallback((key: string) => {
    const item = rows.find((candidate) => candidate.key === key);
    if (item?.kind === "artifact") return undefined;
    if (item) return { target: activityOpenTarget(item), open: key === currentKey };
    const card = waiting.find((candidate) => waitingRowKey(candidate.messageId) === key);
    if (!card) return undefined;
    const target = waitingChoiceTarget(card);
    return { target, open: pane !== undefined && sameOpen(target, pane) };
  });
  const onMove = useLatestCallback((key: string) => {
    clearTimeout(follow.current);
    const target = rowTarget(key)?.target;
    if (!target || target.attachmentId !== undefined) return;
    follow.current = setTimeout(() => {
      if (!rowTarget(key)?.open) onOpen(target);
    }, FOLLOW_DELAY_MS);
  });
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

function sameOpen(target: HostedConversationTarget, pane: HostedConversationTarget) {
  if (hostedConversationOpenParam(target) !== hostedConversationOpenParam(pane)) return false;
  return !target.threadAlone || target.threadRootId === (pane.threadRootId ?? pane.messageId);
}

const FOLLOW_DELAY_MS = 120;
