import type { Dispatch, ReactNode, Ref, SetStateAction } from "react";
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

export type ActionCardFailure = {
  message: string;
  retry: boolean;
  fix?: "edit";
  from: "commit" | "cancel";
};

const TARGET = "max-sm:min-h-11";

export function PendingActionCard({
  frameRef,
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
  frameRef: Ref<HTMLDivElement>;
  view: ToolActionCardView;
  fillValues: Record<string, string>;
  setFillValues: Dispatch<SetStateAction<Record<string, string>>>;
  failure: ActionCardFailure | null;
  committing: boolean;
  cancelling: boolean;
  commitDisabled: boolean;
  onCommit: () => void;
  onEdit: () => void;
  onOpenDesktop?: () => void;
  onCancel: () => void;
}) {
  const deniedReason = actionCardDeniedReason(view);
  const busy = committing || cancelling;
  const retrying = failure?.retry === true && failure.from === "commit";
  const fixInDialog = failure?.fix === "edit";
  const commitLabel = fixInDialog
    ? m.action_card_rename()
    : retrying
      ? m.action_card_retry()
      : actionCardCommitLabel(view, committing);
  return (
    <ActionCardFrame
      ref={frameRef}
      view={view}
      fillValues={fillValues}
      setFillValues={setFillValues}
    >
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
    </ActionCardFrame>
  );
}

const NO_FILL_VALUES: Record<string, string> = {};

export function ActionCardFrame({
  ref,
  view,
  fillValues = NO_FILL_VALUES,
  setFillValues = () => {},
  minHeight,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  view: ToolActionCardView;
  fillValues?: Record<string, string>;
  setFillValues?: Dispatch<SetStateAction<Record<string, string>>>;
  minHeight?: number;
  children: ReactNode;
}) {
  const Icon = actionCardIcon(view.kind);
  const title = actionCardTitle(view);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={title}
      data-no-row-tap
      className="mt-1 flex max-w-md flex-col gap-3 rounded-xl border border-secondary bg-primary p-4"
      style={minHeight ? { minHeight } : undefined}
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

      {children}
    </div>
  );
}
