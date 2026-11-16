import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
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
import { firstPick } from "./question-dock-keys";
import {
  dockQuestions,
  fitDrafts,
  isAskingView,
  isMine,
  nextWaiting,
  submission,
  type AskingView,
  type Drafts,
} from "./question-dock-model";
import {
  dropQuestionDrafts,
  readQuestionDrafts,
  serverQuestionDrafts,
  subscribeQuestionDrafts,
  writeQuestionDrafts,
} from "./question-drafts";
import { focusDraftEnd } from "./composer-field";
import { useDockKeepsCardInView } from "./use-dock-scroll";

/** What the dock shows of the message a card came in: who asked, and when. */
export type DockMessage = {
  id: string;
  senderName: string;
  senderAgentId?: string;
  senderUserId?: string;
  senderAvatarUrl?: string | null;
  createdAt: Date | string;
  actionCard?: ActionCardView;
};

export type DockCard = { message: DockMessage; view: AskingView };

/** Where the dock stands: the card, its question (or review), and the row the keys stand on. */
type DockPlace = { messageId: string; tab: number; hi: number; byKey: boolean };

type QuestionDock = {
  place: DockPlace | null;
  /** The pane's question cards, in stream order, each as the dock last read it. */
  cards: DockCard[];
  /** The cards waiting on the viewer's answer. */
  waiting: DockCard[];
  /** After a card was sent from the dock: the one to offer next. */
  next: DockCard | undefined;
  open: (messageId: string, tab?: number) => void;
  close: () => void;
  setView: (tab: number, hi: number) => void;
  switchBy: (by: 1 | -1) => void;
  /** The card as the dock last read it, newer than the message's while the message has not
   * caught up. */
  viewOf: (view: AskingView) => AskingView;
  submit: (card: DockCard, drafts: Drafts) => Promise<void>;
  decline: (card: DockCard) => Promise<void>;
};

const QuestionDockContext = createContext<QuestionDock | null>(null);

/** What a stream card needs of the dock, apart from the rest so that moving inside the dock (each
 * arrow key, each hover) does not draw every card in the pane again. */
type CardDock = {
  /** The card open in the dock, if any. */
  openId: string | null;
  open: QuestionDock["open"];
  viewOf: QuestionDock["viewOf"];
};

const CardDockContext = createContext<CardDock | null>(null);

/** The dock as a stream card (or the composer) sees it; null outside a conversation pane. */
export function useCardDock() {
  return useContext(CardDockContext);
}

/** The docks open on the page, in the order they opened: a bare Escape closes the last. */
const openDocks: object[] = [];

/** The pane's answer dock (Frank, 11-12); null outside a conversation pane. */
export function useQuestionDock() {
  return useContext(QuestionDockContext);
}

/**
 * One answering surface per conversation pane (Frank, 11-12): a card in the stream is a summary,
 * and its questions are answered in the dock, which takes the composer's place. The host owns
 * which card is open, sends the answers or the decline, and holds each card as it last read it, so
 * the stream card and the dock show the same state before the stream's own refresh comes.
 */
export function QuestionDockHost({
  messages,
  paneRef,
  historyRef,
  children,
}: {
  /** The pane's messages in stream order (a thread's root first). */
  messages: readonly DockMessage[];
  paneRef: RefObject<HTMLElement | null>;
  historyRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [place, setPlace] = useState<DockPlace | null>(null);
  // Views read after the dock acted, each kept only while its message still carries the card it
  // was read over: the stream's next refresh replaces the message, and with it this.
  const [fresh, setFresh] = useState<
    ReadonlyMap<string, { base: ActionCardView; view: AskingView }>
  >(new Map());
  const queryClient = useQueryClient();
  const refresh = useServerFn(loadActionCardStates);
  const commitChoice = useServerFn(commitChoiceActionCard);
  const commitQuestions = useServerFn(commitQuestionsActionCard);
  const cancel = useServerFn(cancelActionCard);
  const desktop = useBreakpoint("sm");
  // Whether the person's last input was a key: a dock opened from the keyboard shows where the
  // arrow keys stand at once; one opened by a pointer waits for the first arrow key.
  const byKey = useRef(false);
  useEffect(() => {
    const onKey = () => (byKey.current = true);
    const onPointer = () => (byKey.current = false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  const cards = useMemo(
    () =>
      messages.flatMap((message): DockCard[] => {
        const base = message.actionCard;
        if (!isAskingView(base)) return [];
        const kept = fresh.get(message.id);
        return [{ message, view: kept?.base === base ? kept.view : base }];
      }),
    [messages, fresh],
  );
  const waiting = useMemo(
    () => cards.filter((card) => card.view.state === "pending" && card.view.canCommit),
    [cards],
  );
  // Someone else's card, looked through, leaves the dock when it stops waiting.
  const current = place
    ? cards.find(
        (card) =>
          card.message.id === place.messageId &&
          (card.view.state === "pending" || isMine(card.view)),
      )
    : undefined;
  const next = useMemo(() => {
    if (!current || current.view.state === "pending") return undefined;
    const id = nextWaiting(
      waiting.map((card) => card.message.id),
      cards.map((card) => card.message.id),
      current.message.id,
    );
    return waiting.find((card) => card.message.id === id);
  }, [current, waiting, cards]);
  useDockKeepsCardInView(historyRef, desktop ? place?.messageId : undefined, current?.view.state);

  const open = useLatestCallback((messageId: string, tab?: number) => {
    const card = cards.find((candidate) => candidate.message.id === messageId);
    if (!card) return;
    const questions = dockQuestions(card.view);
    const to = Math.min(tab ?? 0, questions.length - 1);
    const drafts = readQuestionDrafts(messageId);
    setPlace({
      messageId,
      tab: to,
      hi: firstPick({ questions, drafts }, to),
      byKey: byKey.current,
    });
  });
  const close = useLatestCallback(() => {
    setPlace(null);
    // Focus left with the dock goes back to the composer, and focus elsewhere stays; a phone has no
    // keys, and focusing the composer there raises the keyboard.
    if (window.matchMedia("(pointer: fine)").matches)
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        focusDraftEnd(
          paneRef.current?.querySelector<HTMLTextAreaElement>("[data-composer]") ?? null,
        );
      });
  });
  // Escape closes an open dock wherever focus is in this pane, or, when focus is nowhere, the dock
  // opened last (task #109; a channel's and a thread's can be open at once): the dock's own views
  // handle it first, but a refresh that swaps the view, or a click on the stream, takes focus off
  // them, and Escape must not then do nothing. A popover or menu that used the key marked it
  // handled; nothing else on the page closes on a bare Escape.
  const isOpen = place !== null;
  useEffect(() => {
    if (!isOpen) return;
    const self = {};
    openDocks.push(self);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const at = event.target;
      const nowhere = at === document.body || at === document.documentElement;
      const inPane = at instanceof Node && paneRef.current?.contains(at);
      if (!inPane && !(nowhere && openDocks.at(-1) === self)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openDocks.splice(openDocks.indexOf(self), 1);
    };
  }, [isOpen, close, paneRef]);
  // The card left the pane (an older page dropped, the message deleted) or the dock: so does it.
  useEffect(() => {
    if (place && !current) close();
  }, [place, current, close]);
  const setView = useLatestCallback((tab: number, hi: number) =>
    setPlace((at) => (!at || (at.tab === tab && at.hi === hi) ? at : { ...at, tab, hi })),
  );
  const switchBy = useLatestCallback((by: 1 | -1) => {
    if (!waiting.length) return;
    const at = waiting.findIndex((card) => card.message.id === place?.messageId);
    if (at < 0) return open(waiting[by > 0 ? 0 : waiting.length - 1]!.message.id);
    if (waiting.length > 1) open(waiting[(at + by + waiting.length) % waiting.length]!.message.id);
  });
  // Made again when a view is read, so the cards that use it draw again.
  const viewOf = useCallback(
    (view: AskingView) => {
      const kept = fresh.get(view.messageId);
      return kept?.base === view ? kept.view : view;
    },
    [fresh],
  );

  /** Reads the card again after acting on it, and shows it as the server now has it. */
  async function reread(card: DockCard) {
    const states = await refresh({ data: { messageIds: [card.message.id] } });
    const view = states[card.message.id] as ActionCardView | undefined;
    const base = card.message.actionCard;
    if (!isAskingView(view) || !base) return;
    setFresh((all) => new Map(all).set(card.message.id, { base, view }));
    if (view.state !== "pending") dropQuestionDrafts(card.message.id);
  }

  const submit = useLatestCallback(async (card: DockCard, drafts: Drafts) => {
    const sent = submission(card.view, fitDrafts(dockQuestions(card.view), drafts));
    if (!sent) return;
    try {
      if (sent.kind === "choice")
        await commitChoice({
          data: { messageId: card.message.id, optionId: sent.optionId, text: sent.text },
        });
      else await commitQuestions({ data: { messageId: card.message.id, answers: sent.answers } });
    } catch (cause) {
      // Someone else's change (answered elsewhere, expired): show the card as it now is.
      if (isAppErrorCode(cause, "CONFLICT")) await reread(card).catch(() => {});
      throw cause;
    }
    // Answered, it no longer waits on the viewer in Activity.
    void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY });
    await reread(card).catch(() => {});
  });
  const decline = useLatestCallback(async (card: DockCard) => {
    try {
      await cancel({ data: { messageId: card.message.id } });
    } catch (cause) {
      // Answered, withdrawn or run out meanwhile: show the card as it now is.
      if (isAppErrorCode(cause, "CONFLICT")) await reread(card).catch(() => {});
      throw cause;
    }
    void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY });
    await reread(card).catch(() => {});
  });

  const value = useMemo(
    () => ({
      place,
      cards,
      waiting,
      next,
      open,
      close,
      setView,
      switchBy,
      viewOf,
      submit,
      decline,
    }),
    [place, cards, waiting, next, open, close, setView, switchBy, viewOf, submit, decline],
  );
  const openId = place?.messageId ?? null;
  const cardDock = useMemo(() => ({ openId, open, viewOf }), [openId, open, viewOf]);
  return (
    <QuestionDockContext value={value}>
      <CardDockContext value={cardDock}>{children}</CardDockContext>
    </QuestionDockContext>
  );
}

/** A card's kept answers and the way to change them, the same in the stream and the dock, and in
 * another tab. A card no longer waiting keeps nothing. */
export function useQuestionDrafts(view: AskingView) {
  const messageId = view.messageId;
  const pending = view.state === "pending";
  const subscribe = useCallback(
    (changed: () => void) => subscribeQuestionDrafts(messageId, changed),
    [messageId],
  );
  // A card no longer waiting reads nothing: a long history has many.
  const drafts = useSyncExternalStore(
    subscribe,
    () => (pending ? readQuestionDrafts(messageId) : NO_DRAFTS),
    serverQuestionDrafts,
  );
  useEffect(() => {
    if (!pending) dropQuestionDrafts(messageId);
  }, [pending, messageId]);
  const fitted = useMemo(() => fitDrafts(dockQuestions(view), drafts), [view, drafts]);
  const setDraft = useLatestCallback((questionId: string, draft: Drafts[string]) => {
    const all = { ...readQuestionDrafts(messageId), [questionId]: draft };
    writeQuestionDrafts(messageId, fitDrafts(dockQuestions(view), all));
  });
  return [pending ? fitted : NO_DRAFTS, setDraft] as const;
}

const NO_DRAFTS: Drafts = {};
