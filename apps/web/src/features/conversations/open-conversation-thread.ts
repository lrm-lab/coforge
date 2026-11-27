import { useCallback } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";

import {
  conversationSearchForThread,
  conversationSearchWithoutTask,
  conversationSearchWithoutThread,
  conversationSearchWithTask,
  conversationSearchWithThread,
} from "./conversation-thread-search";
import { keepsLandingForReview } from "./attachment-review-address";

export function useOpenConversationThread() {
  const router = useRouter();
  const searchThreadRootId = useSearch({
    strict: false,
    select: (search) => (typeof search.threadRootId === "string" ? search.threadRootId : undefined),
  });
  const docOpen = useSearch({
    strict: false,
    select: (search) => typeof search.doc === "string",
  });
  const openThread = useCallback(
    (threadRootId: string, options?: { replace?: boolean }) => {
      if (!options?.replace && !docOpen && searchThreadRootId === threadRootId) return;
      void router.navigate({
        to: ".",
        replace: options?.replace,
        resetScroll: false,
        hash: () => "",
        search: (previous) =>
          conversationSearchWithThread(conversationSearchForThread(previous), threadRootId),
      });
    },
    [docOpen, router, searchThreadRootId],
  );
  const openThreadFromHash = useCallback(
    (threadRootId: string) => {
      if (searchThreadRootId === threadRootId) return;
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        hash: true,
        search: (previous) =>
          conversationSearchWithThread(conversationSearchForThread(previous), threadRootId),
      });
    },
    [router, searchThreadRootId],
  );
  const closeThread = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        hash: () => "",
        search: (previous) => conversationSearchWithoutThread(previous),
      }),
    [router],
  );
  const showThreadRoot = useCallback(
    (threadRootId: string) =>
      void router.navigate({
        to: ".",
        resetScroll: false,
        hash: () => "",
        search: (previous) => ({
          ...conversationSearchWithoutThread(previous),
          message: threadRootId,
        }),
      }),
    [router],
  );
  return { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot };
}

type ConversationTaskSearch = { task?: unknown };

export function useOpenConversationTask() {
  const router = useRouter();
  const openTaskNumber = useSearch({
    strict: false,
    select: (search) => (typeof search.task === "number" ? search.task : undefined),
  });
  const openTask = useCallback(
    (task: number) => {
      if (openTaskNumber === task) return;
      void router.navigate({
        to: ".",
        resetScroll: false,
        search: (previous: ConversationTaskSearch) => conversationSearchWithTask(previous, task),
      });
    },
    [router, openTaskNumber],
  );
  const closeTask = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: ConversationTaskSearch) => conversationSearchWithoutTask(previous),
      }),
    [router],
  );
  return { openTaskNumber, openTask, closeTask };
}

export const clearedJumpMessageNavigation = {
  to: ".",
  replace: true,
  resetScroll: false,
  hash: true,
  search: (previous: { message?: string; file?: string }) => ({
    ...previous,
    message: keepsLandingForReview(previous) ? previous.message : undefined,
  }),
} as const;

export function useConversationPositionJump() {
  const router = useRouter();
  const jumpMessageId = useSearch({
    strict: false,
    select: (search) => (typeof search.message === "string" ? search.message : undefined),
  });
  const clearJumpMessage = useCallback(() => {
    void router.navigate(clearedJumpMessageNavigation);
  }, [router]);
  return { jumpMessageId, clearJumpMessage };
}
