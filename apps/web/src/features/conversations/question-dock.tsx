import { useEffect, useRef } from "react";
import { Modal as AriaModal } from "react-aria-components";

import { Dialog, ModalOverlay } from "#src/components/ui/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useQuestionDock } from "./question-dock-host";
import { DockAnswer } from "./question-dock-answer";
import { DockReceipt } from "./question-dock-receipt";
import { isMine } from "./question-dock-model";

/**
 * The pane's dock where its cards are answered (Frank, 11-12), while one is open: on a desktop in
 * the composer's place, at its width; on a phone a sheet from the bottom edge over the stream. One
 * height for its whole life either way, so neither the stream above nor the sheet moves as
 * questions, cards and the receipt change inside it; only the first open moves it in.
 */
export function QuestionDockPanel() {
  const dock = useQuestionDock();
  const desktop = useBreakpoint("sm");
  const place = dock?.place;
  const card = place ? dock.cards.find((each) => each.message.id === place.messageId) : undefined;
  const pending = card?.view.state === "pending";
  // Someone else's card that stopped waiting has already left the dock (the host drops it).
  const shown = card && (pending || isMine(card.view));
  const entered = useRef(false);
  const entering = Boolean(card) && !entered.current;
  useEffect(() => {
    entered.current = Boolean(card);
  });
  if (!dock || !place || !shown) return null;

  const content = pending ? (
    <DockAnswer
      key={card.message.id}
      card={card}
      tab={place.tab}
      hi={place.hi}
      openedByKey={place.byKey}
      readOnly={!card.view.canCommit}
    />
  ) : (
    <DockReceipt key={`${card.message.id}:${card.view.state}`} card={card} />
  );
  const label = m.dock_label({ name: card.message.senderName });

  if (desktop)
    return (
      <section
        data-question-dock=""
        aria-label={label}
        className={cn(
          "relative mx-4 mt-2 mb-3 flex h-[min(26.25rem,calc(100dvh-12.5rem))] flex-col overflow-hidden rounded-xl border border-primary bg-primary md:mx-6",
          entering && "motion-enter animate-in fade-in slide-in-from-bottom-1",
        )}
      >
        {content}
      </section>
    );
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && dock.close()}
      className="items-end px-0 pt-0 pb-0 [--modal-pb:0px] [--modal-pt:0px] sm:px-0"
    >
      <AriaModal
        className={(state) =>
          cn(
            "flex h-[min(37.5rem,calc(var(--visual-viewport-height,100dvh)-2.5rem))] w-full flex-col overflow-hidden rounded-t-2xl bg-primary shadow-xl outline-hidden",
            state.isEntering && "motion-enter-lg animate-in slide-in-from-bottom",
            state.isExiting && "motion-leave-lg animate-out slide-out-to-bottom",
          )
        }
      >
        <Dialog
          data-question-dock=""
          aria-label={label}
          className="flex h-full flex-col overflow-hidden pb-safe-bottom"
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-quaternary/40"
          />
          {content}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
  );
}
