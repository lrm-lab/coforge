import { AlertTriangle, XClose } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { AppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { agentUpdateErrorMessage } from "./agent-form";
import type { BatchAgentEnvSummary, BatchRuntimePreviewPlan } from "./batch-runtime-config-model";
import { runtimeProviderLabel } from "./runtime-provider-display";

export type BatchRuntimeSaveResult = {
  succeeded: Array<{ agentId: string; restart: string }>;
  skipped: Array<{ agentId: string; reason: "unchanged" | "not-owner" }>;
  failed: Array<{ agentId: string; errorId?: string; reason?: string }>;
};

function formatEnvSummary(summary: BatchAgentEnvSummary): string {
  const parts = [
    ...summary.added.map((key) => `+${key}`),
    ...summary.updated.map((key) => `~${key}`),
    ...summary.removed.map((key) => `-${key}`),
  ];
  if (parts.length <= 3) return parts.join(" ");
  return `${parts.slice(0, 3).join(" ")} +${parts.length - 3}`;
}

function failureReasonMessage(item: { errorId?: string; reason?: string }): string {
  if (!item.errorId) return m.agent_update_error();
  return agentUpdateErrorMessage(
    new AppError("INVALID_INPUT", {
      errorId: item.errorId,
      ...(item.reason ? { details: { reason: item.reason } } : {}),
    }),
  );
}

export function BatchAgentRuntimeConfirmDialog({
  open,
  onOpenChange,
  computerOnline,
  previewPlan,
  targetModelDisplay,
  agentNameById,
  failedItems,
  submitError,
  saving,
  canConfirm,
  onConfirm,
  onRetryFailed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computerOnline: boolean;
  previewPlan: BatchRuntimePreviewPlan;
  targetModelDisplay: string;
  agentNameById: ReadonlyMap<string, string>;
  failedItems: BatchRuntimeSaveResult["failed"];
  submitError: string;
  saving: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  onRetryFailed: () => void;
}) {
  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <div className="px-6 pt-6 max-sm:px-4">
                <div className="flex items-start justify-between gap-4">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                  >
                    {m.agent_batch_runtime_confirm_title({ count: previewPlan.changedCount })}
                  </Heading>
                  <ButtonUtility
                    data-dialog-close
                    aria-label={m.controls_close()}
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    isDisabled={saving}
                    onClick={close}
                  />
                </div>

                {previewPlan.excludedCount > 0 && (
                  <p className="mt-2 text-sm text-tertiary">
                    {m.agent_batch_runtime_excluded_notice({
                      count: previewPlan.excludedCount,
                      editable: previewPlan.editableAgents.length,
                    })}
                  </p>
                )}

                <ul className="mt-4 max-h-56 divide-y divide-secondary overflow-y-auto rounded-lg border border-secondary bg-secondary_subtle">
                  {previewPlan.rows.map((row) => {
                    const oldRuntime = row.agent.provider
                      ? `${runtimeProviderLabel(row.agent.provider)}${row.agent.runtimeConfig?.model ? ` · ${row.agent.runtimeConfig.model}` : ""}`
                      : m.agent_profile_runtime_invalid();
                    const badgeColor =
                      row.plan === "restart"
                        ? "warning"
                        : row.plan === "when-idle"
                          ? "brand"
                          : "gray";
                    const badgeText =
                      row.plan === "restart"
                        ? m.agent_batch_runtime_badge_restart()
                        : row.plan === "when-idle"
                          ? m.agent_batch_runtime_badge_when_idle()
                          : row.plan === "deferred"
                            ? m.agent_batch_runtime_badge_deferred()
                            : m.agent_batch_runtime_badge_unchanged();
                    return (
                      <li
                        key={row.agent.id}
                        className="flex items-start justify-between gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-primary">
                            {row.agent.displayName}
                          </p>
                          <p className="mt-0.5 text-xs wrap-anywhere text-tertiary">
                            {row.runtimeChanged ? (
                              <>
                                {oldRuntime} <span aria-hidden="true">→</span>{" "}
                                <span className="font-medium text-primary">
                                  {targetModelDisplay}
                                </span>
                              </>
                            ) : (
                              m.agent_batch_runtime_model_unchanged({ model: oldRuntime })
                            )}
                          </p>
                          {row.envChanged && (
                            <p className="mt-0.5 font-mono text-xs wrap-anywhere text-success-primary">
                              env: {formatEnvSummary(row.envSummary)}
                            </p>
                          )}
                        </div>
                        <Badge size="sm" color={badgeColor}>
                          {badgeText}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>

                {previewPlan.changedCount === 0 ? (
                  <p className="mt-4 rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5 text-sm text-secondary">
                    {m.agent_batch_runtime_unchanged_notice()}
                  </p>
                ) : !computerOnline ? (
                  <p className="mt-4 rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5 text-sm text-secondary">
                    {m.agent_batch_runtime_notice_offline({ count: previewPlan.changedCount })}
                  </p>
                ) : (
                  <div className="mt-4 grid gap-2">
                    {previewPlan.willRestartCount > 0 && (
                      <div className="flex gap-2.5 rounded-lg bg-warning-primary px-3 py-2.5 text-sm text-warning-primary">
                        <AlertTriangle
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-fg-warning-primary"
                        />
                        <p>
                          {m.agent_batch_runtime_warning_restart({
                            restart: previewPlan.willRestartCount,
                          })}
                        </p>
                      </div>
                    )}
                    {previewPlan.whenIdleCount > 0 && (
                      <p className="px-1 text-sm text-secondary">
                        {m.agent_batch_runtime_notice_when_idle({
                          count: previewPlan.whenIdleCount,
                        })}
                      </p>
                    )}
                    {previewPlan.deferredCount > 0 && (
                      <p className="px-1 text-sm text-secondary">
                        {m.agent_batch_runtime_notice_deferred({
                          count: previewPlan.deferredCount,
                        })}
                      </p>
                    )}
                  </div>
                )}

                {previewPlan.missingApiKey && (
                  <p role="alert" className="mt-3 text-sm text-error-primary">
                    {m.agent_form_api_key_required()}
                  </p>
                )}

                {failedItems.length > 0 && (
                  <div
                    role="alert"
                    className="mt-3 grid gap-2 rounded-lg border border-error_subtle bg-error-primary px-3 py-2.5 text-sm text-error-primary"
                  >
                    <p className="font-medium">
                      {m.agent_batch_runtime_failed_heading({ count: failedItems.length })}
                    </p>
                    <ul className="grid gap-1 text-xs">
                      {failedItems.map((item) => (
                        <li key={item.agentId}>
                          {agentNameById.get(item.agentId) ?? item.agentId}:{" "}
                          {failureReasonMessage(item)}
                        </li>
                      ))}
                    </ul>
                    <Button
                      type="button"
                      size="sm"
                      color="secondary"
                      className="justify-self-start"
                      isDisabled={saving}
                      onPress={onRetryFailed}
                    >
                      {m.agent_batch_runtime_retry_failed()}
                    </Button>
                  </div>
                )}

                {submitError && (
                  <p role="alert" className="mt-3 text-sm text-error-primary">
                    {submitError}
                  </p>
                )}
              </div>

              <DialogActions className="px-6 py-4 max-sm:px-4">
                <DialogCancel type="button" isDisabled={saving} onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  autoFocus
                  type="button"
                  isDisabled={!canConfirm}
                  isLoading={saving}
                  showTextWhileLoading
                  onPress={onConfirm}
                >
                  {saving
                    ? m.agent_profile_saving()
                    : m.agent_batch_runtime_confirm_submit({ count: previewPlan.changedCount })}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
