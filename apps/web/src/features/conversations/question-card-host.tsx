import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { isAppErrorCode } from "#src/lib/app-error";
import { WAITING_CHOICE_CARDS_KEY } from "#src/features/inbox/activity-inbox-queries";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import {
  cancelActionCard,
  commitChoiceActionCard,
  commitQuestionsActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import {
  cardQuestions,
  fitDrafts,
  isAskingView,
  submission,
  type AskingView,
  type Drafts,
} from "./question-card-model";
import {
  dropQuestionDrafts,
  readQuestionDrafts,
  serverQuestionDrafts,
  subscribeQuestionDrafts,
  writeQuestionDrafts,
} from "./question-drafts";

type CardMessage = { id: string; actionCard?: ActionCardView };

type QuestionCards = {
  viewOf: (view: AskingView) => AskingView;
  submit: (view: AskingView, drafts: Drafts) => Promise<void>;
  decline: (view: AskingView) => Promise<void>;
  focusWaiting: (by: 1 | -1, fromId?: string) => boolean;
};

const QuestionCardsContext = createContext<QuestionCards | null>(null);

export function useQuestionCards() {
  return useContext(QuestionCardsContext);
}

function cardKeysTarget(root: ParentNode | null | undefined, messageId: string) {
  return root?.querySelector<HTMLElement>(
    `[data-question-card][data-message="${CSS.escape(messageId)}"] [data-question-options]`,
  );
}

export function QuestionCardsHost({
  messages,
  paneRef,
  children,
}: {
  messages: readonly CardMessage[];
  paneRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [fresh, setFresh] = useState<
    ReadonlyMap<string, { base: ActionCardView; view: AskingView }>
  >(new Map());
  const queryClient = useQueryClient();
  const refresh = useServerFn(loadActionCardStates);
  const commitChoice = useServerFn(commitChoiceActionCard);
  const commitQuestions = useServerFn(commitQuestionsActionCard);
  const cancel = useServerFn(cancelActionCard);

  const viewOf = useCallback(
    (view: AskingView) => {
      const kept = fresh.get(view.messageId);
      return kept?.base === view ? kept.view : view;
    },
    [fresh],
  );

  const focusWaiting = useLatestCallback((by: 1 | -1, fromId?: string) => {
    const waiting = messages.flatMap((message) => {
      const base = message.actionCard;
      if (!isAskingView(base)) return [];
      const view = viewOf(base);
      return view.state === "pending" && view.canCommit ? [message.id] : [];
    });
    if (!waiting.length) return false;
    const at = fromId ? waiting.indexOf(fromId) : -1;
    const id =
      at < 0
        ? waiting[by > 0 ? 0 : waiting.length - 1]!
        : waiting[(at + by + waiting.length) % waiting.length]!;
    const target = cardKeysTarget(paneRef.current, id);
    if (!target) return false;
    target.focus({ preventScroll: true });
    target.closest("[data-question-card]")?.scrollIntoView({ block: "nearest" });
    return true;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const at = event.target;
      if (!(at instanceof HTMLElement) || !paneRef.current?.contains(at)) return;
      if (at.closest("[data-question-card]")) return;
      const down = event.key === "ArrowDown";
      if (at instanceof HTMLTextAreaElement || at instanceof HTMLInputElement) {
        const caret = down ? at.value.length : 0;
        if (at.selectionStart !== caret || at.selectionEnd !== caret) return;
      }
      if (focusWaiting(down ? 1 : -1)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusWaiting, paneRef]);

  async function reread(view: AskingView) {
    const messageId = view.messageId;
    const states = await refresh({ data: { messageIds: [messageId] } });
    const next = states[messageId] as ActionCardView | undefined;
    const base = messages.find((message) => message.id === messageId)?.actionCard;
    if (!isAskingView(next) || !base) return;
    setFresh((all) => new Map(all).set(messageId, { base, view: next }));
    if (next.state !== "pending") dropQuestionDrafts(messageId);
  }

  async function settle(view: AskingView, act: () => Promise<unknown>) {
    try {
      await act();
    } catch (cause) {
      if (isAppErrorCode(cause, "CONFLICT")) await reread(view).catch(() => {});
      throw cause;
    }
    void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY });
    await reread(view).catch(() => {});
  }

  const submit = useLatestCallback(async (view: AskingView, drafts: Drafts) => {
    const sent = submission(view, fitDrafts(cardQuestions(view), drafts));
    if (!sent) return;
    const messageId = view.messageId;
    await settle(view, () =>
      sent.kind === "choice"
        ? commitChoice({ data: { messageId, optionId: sent.optionId, text: sent.text } })
        : commitQuestions({ data: { messageId, answers: sent.answers } }),
    );
  });
  const decline = useLatestCallback((view: AskingView) =>
    settle(view, () => cancel({ data: { messageId: view.messageId } })),
  );

  const value = useMemo(
    () => ({ viewOf, submit, decline, focusWaiting }),
    [viewOf, submit, decline, focusWaiting],
  );
  return <QuestionCardsContext value={value}>{children}</QuestionCardsContext>;
}

export function useQuestionDrafts(view: AskingView) {
  const messageId = view.messageId;
  const pending = view.state === "pending" && view.canCommit;
  const subscribe = useCallback(
    (changed: () => void) => subscribeQuestionDrafts(messageId, changed),
    [messageId],
  );
  const drafts = useSyncExternalStore(
    subscribe,
    () => (pending ? readQuestionDrafts(messageId) : NO_DRAFTS),
    serverQuestionDrafts,
  );
  useEffect(() => {
    if (!pending) dropQuestionDrafts(messageId);
  }, [pending, messageId]);
  const fitted = useMemo(() => fitDrafts(cardQuestions(view), drafts), [view, drafts]);
  const setDraft = useLatestCallback((questionId: string, draft: Drafts[string]) => {
    const all = { ...readQuestionDrafts(messageId), [questionId]: draft };
    writeQuestionDrafts(messageId, fitDrafts(cardQuestions(view), all));
  });
  return [pending ? fitted : NO_DRAFTS, setDraft] as const;
}

const NO_DRAFTS: Drafts = {};
