import type { ReactNode } from "react";
import { AlertTriangle } from "@untitledui/icons";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { PHONE_PAGE_HEADER, PhoneFormBar } from "#src/components/ui/phone-form-bar";
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

export function BatchAgentRuntimeConfirmStep({
  computerOnline,
  previewPlan,
  targetModelDisplay,
  stepHeaderDescription,
  agentNameById,
  failedItems,
  submitError,
  saving,
  canConfirm,
  onBack,
  onClose,
  onConfirm,
  onRetryFailed,
}: {
  computerOnline: boolean;
  previewPlan: BatchRuntimePreviewPlan;
  targetModelDisplay: string;
  stepHeaderDescription: ReactNode;
  agentNameById: ReadonlyMap<string, string>;
  failedItems: BatchRuntimeSaveResult["failed"];
  submitError: string;
  saving: boolean;
  canConfirm: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onRetryFailed: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden max-sm:min-h-full">
      <PhoneFormBar
        heading={m.agent_batch_runtime_confirm_title({ count: previewPlan.changedCount })}
        submitLabel={m.controls_save()}
        pending={saving}
        submitDisabled={!canConfirm}
        onCancel={() => {
          if (!saving) onBack();
        }}
        onSubmit={onConfirm}
      />
      <DialogHeader
        className={`${PHONE_PAGE_HEADER} shrink-0`}
        title={m.agent_batch_runtime_confirm_title({ count: previewPlan.changedCount })}
        description={stepHeaderDescription}
        onClose={saving ? undefined : onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-6 pb-2 max-sm:px-4 max-sm:pt-2 max-sm:pb-6">
        <ul className="max-h-64 divide-y divide-secondary overflow-y-auto rounded-lg border border-secondary bg-secondary_subtle">
          {previewPlan.rows.map((row) => {
            const oldRuntime = row.agent.provider
              ? `${runtimeProviderLabel(row.agent.provider)}${row.agent.runtimeConfig?.model ? ` · ${row.agent.runtimeConfig.model}` : ""}`
              : m.agent_profile_runtime_invalid();
            const badgeColor =
              row.plan === "restart" ? "warning" : row.plan === "when-idle" ? "brand" : "gray";
            const badgeText =
              row.plan === "restart"
                ? m.agent_batch_runtime_badge_restart()
                : row.plan === "when-idle"
                  ? m.agent_batch_runtime_badge_when_idle()
                  : row.plan === "deferred"
                    ? m.agent_batch_runtime_badge_deferred()
                    : m.agent_batch_runtime_badge_unchanged();
            return (
              <li key={row.agent.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">
                    {row.agent.displayName}
                  </p>
                  <p className="mt-0.5 text-xs wrap-anywhere text-tertiary">
                    {row.runtimeChanged ? (
                      <>
                        {oldRuntime} <span aria-hidden="true">→</span>{" "}
                        <span className="font-medium text-primary">{targetModelDisplay}</span>
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
          <p className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5 text-sm text-secondary">
            {m.agent_batch_runtime_unchanged_notice()}
          </p>
        ) : !computerOnline ? (
          <p className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5 text-sm text-secondary">
            {m.agent_batch_runtime_notice_offline({ count: previewPlan.changedCount })}
          </p>
        ) : (
          <div className="grid gap-2">
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
              <p className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2 text-sm text-secondary">
                {m.agent_batch_runtime_notice_when_idle({ count: previewPlan.whenIdleCount })}
              </p>
            )}
            {previewPlan.deferredCount > 0 && (
              <p className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2 text-sm text-secondary">
                {m.agent_batch_runtime_notice_deferred({ count: previewPlan.deferredCount })}
              </p>
            )}
          </div>
        )}

        {previewPlan.missingApiKey && (
          <p role="alert" className="text-sm text-error-primary">
            {m.agent_form_api_key_required()}
          </p>
        )}

        {failedItems.length > 0 && (
          <div
            role="alert"
            className="grid gap-2 rounded-lg border border-error_subtle bg-error-primary px-3 py-2.5 text-sm text-error-primary"
          >
            <p className="font-medium">
              {m.agent_batch_runtime_failed_heading({ count: failedItems.length })}
            </p>
            <ul className="grid gap-1 text-xs">
              {failedItems.map((item) => (
                <li key={item.agentId}>
                  {agentNameById.get(item.agentId) ?? item.agentId}: {failureReasonMessage(item)}
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
          <p role="alert" className="text-sm text-error-primary">
            {submitError}
          </p>
        )}
      </div>

      <DialogActions className="shrink-0 justify-between px-6 pt-4 pb-6 max-sm:hidden">
        <Button type="button" size="md" color="tertiary" isDisabled={saving} onPress={onBack}>
          {m.agent_batch_runtime_back()}
        </Button>
        <div className="flex items-center gap-3">
          <DialogCancel type="button" isDisabled={saving} onPress={onClose}>
            {m.controls_cancel()}
          </DialogCancel>
          <DialogAction
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
        </div>
      </DialogActions>
    </div>
  );
}
