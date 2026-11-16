import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useQuestionDock, type DockCard } from "./question-card-host";
import { dockQuestions, givenAnswers } from "./question-card-model";
import { AnswerLine, DOCK_ROW, DockTop } from "./question-dock-parts";

/**
 * The dock after a card is sent from it (Frank, 11-12): which card, what was said (or that the
 * Agent was told no answer is coming), and the way on, to the next card waiting or done. A card
 * that closed some other way while open (answered elsewhere, expired) says how it stands.
 */
export function DockReceipt({ card }: { card: DockCard }) {
  const dock = useQuestionDock()!;
  const { view, message } = card;
  const rootRef = useRef<HTMLDivElement>(null);
  const controlSize = useDialogControlSize();
  const next = dock.next;
  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [view.messageId]);
  const answered = view.state === "executed";
  const given = givenAnswers(view);
  // Declined by the viewer, or closed by someone else while it was open (withdrawn, run out).
  const declined = view.state === "cancelled" && view.committedBy?.isViewer;
  // The head above names the Agent; this says only how it went.
  const title = answered
    ? m.dock_sent()
    : declined
      ? m.question_card_declined_you()
      : view.state === "expired"
        ? m.action_card_expired()
        : m.question_card_withdrawn();
  const onNext = () => (next ? dock.open(next.message.id) : dock.close());

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") dock.close();
    else if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))
      dock.switchBy(event.key === "ArrowDown" ? 1 : -1);
    else if (event.key === "Enter" && event.target === rootRef.current) onNext();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      ref={rootRef}
      data-dock-receipt=""
      tabIndex={-1}
      aria-label={title}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <DockTop message={message}>
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={XClose}
          tooltip={m.dock_collapse()}
          tooltipShortcut="esc"
          onClick={() => dock.close()}
        />
      </DockTop>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-3 pb-2">
        <div className="flex items-center gap-2 px-2 pb-2 text-md font-medium text-primary">
          <p role="status" className="min-w-0 flex-1 wrap-anywhere">
            {title}
          </p>
        </div>
        {answered &&
          dockQuestions(view).map((question) => (
            <div
              key={question.id}
              className={cn(DOCK_ROW, "cursor-default hover:bg-transparent active:bg-transparent")}
            >
              <AnswerLine question={question} draft={given[question.id]} />
            </div>
          ))}
      </div>
      <div className="flex min-h-13 shrink-0 items-center gap-3 border-t border-secondary py-2 pr-3 pl-4 max-sm:px-4 max-sm:py-3">
        <span className="flex-1" />
        <Button size={controlSize} color="secondary" onPress={onNext}>
          {next ? (
            // The next card by its asker's face: who is asking says which it is.
            <span className="flex items-center gap-1.5">
              <ActorAvatar
                size="xs"
                presence={false}
                agentId={next.message.senderAgentId}
                userId={next.message.senderUserId}
                name={next.message.senderName}
                src={next.message.senderAvatarUrl}
                className="size-4"
              />
              {m.dock_next_card()}
            </span>
          ) : (
            m.dock_done()
          )}
        </Button>
      </div>
    </div>
  );
}
