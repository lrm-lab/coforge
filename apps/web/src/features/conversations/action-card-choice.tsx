import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

type ChoiceView = Extract<ActionCardView, { kind: "choice" }>;

/** A, B, C… for the options in their order: what a person says ("B") when they answer by typing. */
const letter = (index: number) => String.fromCharCode(65 + index);

/**
 * An Agent's question with lettered options. The asked person picks one and the card closes on it:
 * the question, then the chosen option alone. Everyone else reads the options and whom the card
 * waits on. No header or status line: the question is the card.
 */
export function ChoiceActionCard({
  view,
  error,
  cancelling,
  onPick,
  onCancel,
}: {
  view: ChoiceView;
  error: string;
  cancelling: boolean;
  /** Resolves once the pick is stored (or failed); the card then shows what the server says. */
  onPick: (optionId: string) => Promise<void>;
  onCancel: () => void;
}) {
  // The option being sent: it reads as chosen at once, and the others wait, until the card returns.
  const [picking, setPicking] = useState<string>();
  const executed = view.state === "executed";
  const chosen = executed ? view.result?.optionId : picking;
  // Whom it waits on, for anyone but the asked person; whom it was answered by, likewise.
  const waitingOn =
    view.state === "pending" && !view.canCommit ? view.asked?.displayName : undefined;
  const answeredBy = executed && !view.asked?.isViewer ? view.committedBy?.displayName : undefined;
  // The asked person answers or types instead; withdrawing is for the Agent's owner or an admin.
  const withdrawable = view.canCancel && !view.canCommit;
  return (
    <div
      className={cn(
        "mt-1 flex max-w-md flex-col gap-2 rounded-xl border border-secondary bg-primary p-3 shadow-xs",
        view.state === "cancelled" && "opacity-60",
      )}
    >
      <p className="px-1 text-sm font-medium wrap-anywhere text-primary">{view.prompt}</p>
      <ul className="flex flex-col">
        {view.options.map((option, index) => {
          const isChosen = option.id === chosen;
          if (executed && !isChosen) return null;
          const row = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
                  isChosen
                    ? "bg-brand-solid text-white"
                    : "bg-secondary text-tertiary ring-1 ring-secondary ring-inset",
                  !picking &&
                    "group-hover:bg-primary group-hover:text-brand-secondary group-hover:ring-brand",
                )}
              >
                {letter(index)}
              </span>
              <span className="min-w-0 flex-1 text-sm wrap-anywhere text-primary">
                {option.label}
              </span>
              {answeredBy && <span className="shrink-0 text-xs text-tertiary">{answeredBy}</span>}
            </>
          );
          return (
            <li key={option.id}>
              {view.canCommit ? (
                <AriaButton
                  aria-label={`${letter(index)}. ${option.label}`}
                  // Stays focusable while the pick is sent, so a failed pick leaves focus here.
                  aria-disabled={picking ? true : undefined}
                  onPress={async () => {
                    if (picking) return;
                    setPicking(option.id);
                    try {
                      await onPick(option.id);
                    } finally {
                      setPicking(undefined);
                    }
                  }}
                  className={cn(
                    "group flex w-full cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-left outline-focus-ring focus-visible:outline-2",
                    "hover:bg-primary_hover aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
                    picking && !isChosen && "opacity-50",
                  )}
                >
                  {row}
                </AriaButton>
              ) : (
                <div className="flex items-center gap-3 px-1 py-1.5">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="px-1 text-sm text-error-primary">
          {error}
        </p>
      )}
      {/* Whom it waits on and the way to withdraw it, on one line. */}
      {(waitingOn || withdrawable) && (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-tertiary">
            {waitingOn && m.action_card_choice_waiting({ name: waitingOn })}
          </p>
          {withdrawable && (
            <Button size="sm" color="link-gray" isDisabled={cancelling} onPress={onCancel}>
              {cancelling ? m.action_card_cancelling() : m.action_card_dismiss()}
            </Button>
          )}
        </div>
      )}
      {view.state === "cancelled" && (
        <p className="px-1 text-xs text-tertiary">{m.action_card_cancelled()}</p>
      )}
    </div>
  );
}
