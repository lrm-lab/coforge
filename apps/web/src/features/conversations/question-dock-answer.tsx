import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import { useQuestionDock, useQuestionDrafts, type DockCard } from "./question-card-host";
import { dockKey, goOn, reviewTab, turnTo, type DockKeyAction } from "./question-card-keys";
import { answered, dockQuestions, type Draft } from "./question-card-model";
import { altKey, DockTabs, DockTop } from "./question-dock-parts";
import { QuestionPage, ReviewPage } from "./question-dock-pages";
import { cardStatus } from "./question-card-status";
import { DockDecline } from "./question-dock-decline";
import { reveal } from "./question-dock-reveal";

/**
 * The dock answering a card (Frank, 11-12): its questions as tabs, one page each with the options
 * to tick, and on a card of several a review before sending; or someone else's card, to look
 * through. Keys work from anywhere in it (`dockKey`); the highlight shows only once they are used,
 * so nothing looks picked that was not.
 */
export function DockAnswer({
  card,
  tab,
  hi,
  openedByKey,
  readOnly,
}: {
  card: DockCard;
  tab: number;
  hi: number;
  openedByKey: boolean;
  readOnly: boolean;
}) {
  const dock = useQuestionDock()!;
  const { view, message } = card;
  const [drafts, setDraft] = useQuestionDrafts(view);
  const [kbd, setKbd] = useState(openedByKey);
  const [sending, setSending] = useState(false);
  // A send that failed says so at the dock's foot until the next try.
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const otherRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const controlSize = useDialogControlSize();
  const questions = useMemo(() => dockQuestions(view), [view]);
  const review = reviewTab(questions, readOnly);
  const onReview = tab === review;
  const question = questions[tab];
  const draft = question ? drafts[question.id] : undefined;
  const anyAnswered = questions.some((candidate) => answered(drafts[candidate.id]));
  const keyState = { questions, drafts, tab, hi, kbd, readOnly };
  const switching = dock.waiting.length > 1 && !readOnly;

  // A card opened (or turned to) puts the keys on its current page.
  useLayoutEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>("[data-dock-page-current] [data-dock-list]")
      ?.focus({ preventScroll: true });
  }, [view.messageId]);
  // Turning the page makes the old one inert, which drops the focus it held: the keys go on in
  // the new page's list, unless the focus is somewhere else that still holds it.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !rootRef.current?.contains(active)) return;
    if (active instanceof HTMLInputElement) return;
    rootRef.current
      ?.querySelector<HTMLElement>("[data-dock-page-current] [data-dock-list]")
      ?.focus({ preventScroll: true });
  }, [tab]);
  // Focus follows the keys only: a pointer moving over the rows never takes it from the own-words
  // input, where a sentence may be mid-composition.
  const otherRow = question?.other ? question.options.length : -1;
  useLayoutEffect(() => {
    if (!kbd) return;
    const active = document.activeElement;
    if (hi === otherRow && !onReview) otherRefs.current[tab]?.focus({ preventScroll: true });
    else if (active instanceof HTMLInputElement && rootRef.current?.contains(active))
      rootRef.current
        .querySelector<HTMLElement>("[data-dock-page-current] [data-dock-list]")
        ?.focus({ preventScroll: true });
    reveal(
      bodyRef.current,
      bodyRef.current?.querySelector("[data-dock-page-current] [data-hi]"),
      "y",
    );
  }, [tab, hi, view.messageId, kbd, onReview, otherRow]);
  // Only the dock's own strips scroll: the stream keeps the card in view above it.
  useLayoutEffect(() => {
    reveal(tabsRef.current, tabsRef.current?.querySelector(`[data-dock-tab="${tab}"]`), "x", 24);
  }, [tab]);

  async function submit(patch?: Record<string, Draft>) {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      await dock.submit(card, { ...drafts, ...patch });
    } catch {
      setError(m.dock_send_failed());
    } finally {
      setSending(false);
    }
  }

  function pick(row: number) {
    if (!question) return;
    dock.setView(tab, row);
    if (readOnly || row >= question.options.length) return;
    const id = question.options[row]!.id;
    const selection = draft?.selection ?? [];
    const many = question.select === "many";
    setDraft(question.id, {
      selection: many
        ? selection.includes(id)
          ? selection.filter((picked) => picked !== id)
          : [...selection, id]
        : [id],
      text: many ? (draft?.text ?? "") : "",
    });
  }

  function act(action: DockKeyAction) {
    switch (action.do) {
      case "close":
        return dock.close();
      case "switch":
        return dock.switchBy(action.by);
      case "showKeys":
        return setKbd(true);
      case "view":
        return dock.setView(action.tab, action.hi);
      case "pick":
        return pick(action.row);
      case "confirm": {
        const id = question!.options[action.row]!.id;
        const patch = { [question!.id]: { selection: [id], text: "" } };
        setDraft(question!.id, patch[question!.id]!);
        if (questions.length === 1) return void submit(patch);
        return act(goOn({ ...keyState, drafts: { ...drafts, ...patch } }));
      }
      case "submit":
        return void submit();
      default:
        return;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A key in a popover over the dock (the decline's) is that popover's.
    if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) return;
    const target = event.target as HTMLElement;
    const action = dockKey(keyState, {
      key: event.key,
      alt: event.altKey,
      mod: event.metaKey || event.ctrlKey,
      typing: target instanceof HTMLInputElement,
      onControl: Boolean(target.closest("button, a")),
    });
    // Safari ends the composition before the Enter that picks a candidate (key code 229).
    if (action.do === "pass" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    act(action);
  }

  const queueAt = dock.waiting.findIndex((waiting) => waiting.message.id === view.messageId);
  const decline = (place: "top" | "foot") => !readOnly && <DockDecline card={card} place={place} />;

  return (
    <div
      ref={rootRef}
      data-dock={readOnly ? "viewing" : "answering"}
      data-dock-keys={kbd ? "" : undefined}
      onKeyDown={onKeyDown}
      onPointerMove={(event) => {
        if (kbd && event.pointerType === "mouse") setKbd(false);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DockTop message={message}>
        {/* Set apart from the card controls by room, not a rule. */}
        {decline("top")}
        {!readOnly && <span className="w-3 shrink-0 max-sm:hidden" />}
        {switching && (
          <div className="flex shrink-0 items-center gap-0.5 text-xs whitespace-nowrap text-quaternary tabular-nums">
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={ChevronLeft}
              tooltip={m.dock_prev_card()}
              tooltipShortcut={`${altKey()}↑`}
              onClick={() => dock.switchBy(-1)}
            />
            <span className="px-1">
              {m.dock_queue({ index: queueAt + 1, total: dock.waiting.length })}
            </span>
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={ChevronRight}
              tooltip={m.dock_next_card()}
              tooltipShortcut={`${altKey()}↓`}
              onClick={() => dock.switchBy(1)}
            />
          </div>
        )}
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={XClose}
          tooltip={readOnly ? m.dock_collapse() : m.dock_later()}
          tooltipShortcut="esc"
          onClick={() => dock.close()}
        />
      </DockTop>
      {questions.length > 1 && (
        <DockTabs
          questions={questions}
          drafts={drafts}
          tab={tab}
          review={review}
          tabsRef={tabsRef}
          onTurn={(to) => act(turnTo(keyState, to))}
        />
      )}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid px-2 pt-3">
          {questions.map((page, index) => (
            <QuestionPage
              key={page.id}
              id={`${view.messageId}-${index}`}
              question={page}
              draft={drafts[page.id]}
              current={index === tab}
              hi={hi}
              kbd={kbd}
              readOnly={readOnly}
              otherRef={(element) => {
                otherRefs.current[index] = element;
              }}
              onHover={(row) => dock.setView(index, row)}
              onPick={pick}
              onDraft={(next) => setDraft(page.id, next)}
            />
          ))}
          {review !== undefined && (
            <ReviewPage
              id={`${view.messageId}-review`}
              questions={questions}
              drafts={drafts}
              current={onReview}
              hi={hi}
              kbd={kbd}
              onHover={(row) => dock.setView(review, row)}
              onTurn={(row) => act(turnTo(keyState, row))}
            />
          )}
        </div>
      </div>
      <div className="flex min-h-13 shrink-0 items-center gap-3 border-t border-secondary py-2 pr-3 pl-4 max-sm:px-4 max-sm:py-3">
        {decline("foot")}
        {error && (
          <p role="alert" className="min-w-0 truncate text-sm text-error-primary">
            {error}
          </p>
        )}
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-3">
          {readOnly ? (
            <span className="text-sm text-tertiary">{cardStatus(view, { mine: false })}</span>
          ) : onReview || questions.length === 1 ? (
            <Button
              data-dock-submit=""
              size={controlSize}
              color="primary"
              isDisabled={!anyAnswered}
              isLoading={sending}
              showTextWhileLoading
              onPress={() => void submit()}
            >
              {sending ? m.dock_sending() : m.dock_send()}
            </Button>
          ) : (
            // Unanswered, the next question leaves this one skipped, as the review then shows.
            <Button size={controlSize} color="secondary" onPress={() => act(goOn(keyState))}>
              {m.action_card_questions_next()}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
