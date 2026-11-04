import type { Dispatch, SetStateAction } from "react";
import { AlertCircle, Clock } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import {
  actionCardCancelLabel,
  actionCardCommitLabel,
  actionCardDeniedReason,
  actionCardEditable,
  actionCardTitle,
  type ToolActionCardView,
} from "./action-card-labels";
import { actionCardIcon } from "./action-card-icons";
import { ActionCardObject } from "./action-card-object";

/** Why the last request failed. A cancel that failed leaves the card's own button as it was; a
 * commit that only the dialog can fix (`fix: "edit"`, a name taken since) makes the dialog the
 * primary button. */
export type ActionCardFailure = {
  message: string;
  retry: boolean;
  fix?: "edit";
  from: "commit" | "cancel";
};

/** One touch target on a phone, as the choice card's rows are. */
const TARGET = "max-sm:min-h-11";

/**
 * A card waiting on someone: the verb, what it would make, then one primary button that does it.
 * The draft is committed as shown; Edit opens the dialog for the kinds that have one, and Dismiss
 * is for whoever may cancel. Someone who cannot act sees the same preview and whom it waits on,
 * with no buttons (task #449).
 */
export function PendingActionCard({
  view,
  fillValues,
  setFillValues,
  failure,
  committing,
  cancelling,
  commitDisabled,
  onCommit,
  onEdit,
  onOpenDesktop,
  onCancel,
}: {
  view: ToolActionCardView;
  fillValues: Record<string, string>;
  setFillValues: Dispatch<SetStateAction<Record<string, string>>>;
  failure: ActionCardFailure | null;
  committing: boolean;
  cancelling: boolean;
  /** The draft cannot be committed yet (a field still empty, the Projects still loading). */
  commitDisabled: boolean;
  onCommit: () => void;
  onEdit: () => void;
  /** Set while the card's cloud desktop can be opened. */
  onOpenDesktop?: () => void;
  onCancel: () => void;
}) {
  const Icon = actionCardIcon(view.kind);
  const title = actionCardTitle(view);
  const deniedReason = actionCardDeniedReason(view);
  const busy = committing || cancelling;
  // The failed commit is sent again as it is; a failed cancel leaves the primary button alone.
  const retrying = failure?.retry === true && failure.from === "commit";
  const fixInDialog = failure?.fix === "edit";
  const commitLabel = fixInDialog
    ? m.action_card_rename()
    : retrying
      ? m.action_card_retry()
      : actionCardCommitLabel(view, committing);
  return (
    <div
      role="group"
      aria-label={title}
      className="mt-1 flex max-w-md flex-col gap-3 rounded-xl border border-secondary bg-primary p-4 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-md bg-tertiary text-secondary">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold wrap-anywhere text-primary">
          {title}
        </span>
      </div>

      <ActionCardObject view={view} fillValues={fillValues} setFillValues={setFillValues} />

      {failure && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-error-primary">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 wrap-anywhere">{failure.message}</span>
        </p>
      )}

      {(view.canCommit || view.canCancel || deniedReason) && (
        <div className="flex flex-wrap items-center gap-2">
          {view.canCommit ? (
            <>
              <Button
                size="sm"
                className={TARGET}
                isLoading={committing}
                showTextWhileLoading
                isDisabled={busy || commitDisabled}
                onPress={fixInDialog ? onEdit : onCommit}
              >
                {commitLabel}
              </Button>
              {actionCardEditable(view) && !fixInDialog && (
                <Button
                  size="sm"
                  color="secondary"
                  className={TARGET}
                  isDisabled={busy || commitDisabled}
                  onPress={onEdit}
                >
                  {m.action_card_edit()}
                </Button>
              )}
              {onOpenDesktop && (
                <Button
                  size="sm"
                  color="secondary"
                  className={TARGET}
                  isDisabled={busy}
                  onPress={onOpenDesktop}
                >
                  {m.action_card_open_desktop()}
                </Button>
              )}
            </>
          ) : (
            // Whom it waits on, beside Dismiss for whoever may still cancel it.
            deniedReason && (
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-tertiary">
                <Clock aria-hidden="true" className="size-3.5 shrink-0" />
                {deniedReason}
              </p>
            )
          )}
          {view.canCancel && (
            <Button
              size="sm"
              color="tertiary"
              className={`${TARGET} ml-auto`}
              isDisabled={busy}
              onPress={onCancel}
            >
              {actionCardCancelLabel(view, cancelling)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
