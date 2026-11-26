import { useEffect, useMemo, useState } from "react";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { AppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { BatchUpdateAgentRuntimeConfigClientInput } from "./agent.schemas";
import { agentUpdateErrorMessage, sizesFromForm } from "./agent-form";
import {
  AgentRuntimeConfigDialog,
  type AgentEnvironmentState,
} from "./agent-runtime-config-dialog";
import type { RuntimeOptions, RuntimeSelection } from "./agent-runtime-fields";
import {
  buildInitialBatchRuntimeSelection,
  hasHeterogeneousBatchRuntime,
  parseBatchEnvPatch,
  planBatchRuntimePreview,
  type BatchRuntimePreviewAgent,
  type ParsedBatchEnvPatch,
} from "./batch-runtime-config-model";

export type BatchRuntimeSaveResult = {
  succeeded: Array<{ agentId: string; restart: string }>;
  skipped: Array<{ agentId: string; reason: "unchanged" | "not-owner" }>;
  failed: Array<{ agentId: string; errorId?: string; reason?: string }>;
};

const EMPTY_BATCH_ENVIRONMENT: AgentEnvironmentState = { loaded: true, values: {} };

type PendingBatchDraft = {
  keepRuntime: boolean;
  selection: RuntimeSelection | undefined;
  apiKey: string;
  envPatch: ParsedBatchEnvPatch;
};

class PartialBatchFailureError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function selectionFromForm(form: FormData): { selection: RuntimeSelection; apiKey: string } {
  const provider = parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE;
  const apiKey = String(form.get("apiKey") ?? "").trim();
  return {
    selection: {
      provider,
      modelProvider: String(form.get("modelProvider") ?? "").trim(),
      model: String(form.get("model") ?? "").trim(),
      reasoning: String(form.get("reasoning") ?? "").trim(),
      fastMode: form.get("fastMode") === "true",
      ...sizesFromForm(form),
    },
    apiKey,
  };
}

function envRowsFromForm(form: FormData): Array<{ key: string; value: string }> {
  const keys = form.getAll("envKey");
  const values = form.getAll("envValue");
  return keys.map((key, index) => ({
    key: String(key ?? ""),
    value: String(values[index] ?? ""),
  }));
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

export function BatchAgentRuntimeConfigDialog({
  open,
  onOpenChange,
  computerId,
  computerOnline,
  agents,
  initialOptions,
  onLoadRuntimeOptions,
  onLoadEnvironmentKeys,
  onSubmitBatch,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computerId: string;
  computerOnline: boolean;
  agents: readonly BatchRuntimePreviewAgent[];
  initialOptions?: RuntimeOptions;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadEnvironmentKeys?: (agentIds: string[]) => Promise<Record<string, string[]>>;
  onSubmitBatch: (
    input: BatchUpdateAgentRuntimeConfigClientInput,
  ) => Promise<BatchRuntimeSaveResult>;
  onSaved: (result: BatchRuntimeSaveResult) => void;
}) {
  const editableAgents = useMemo(
    () => agents.filter((agent) => agent.ownedByCurrentUser),
    [agents],
  );
  const fallbackProvider =
    parseRuntimeProvider(initialOptions?.providers[0]) ?? RUNTIME_PROVIDER.COFORGE;
  const initialSelection = useMemo(
    () => buildInitialBatchRuntimeSelection(agents, fallbackProvider),
    [agents, fallbackProvider],
  );
  const allowUnchangedSubmit = useMemo(
    () => hasHeterogeneousBatchRuntime(agents, initialSelection),
    [agents, initialSelection],
  );

  const [envKeysByAgent, setEnvKeysByAgent] = useState<Record<string, string[]> | undefined>(
    undefined,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<PendingBatchDraft | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [retryAgentIds, setRetryAgentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      setConfirmOpen(false);
      setDraft(undefined);
      setRetryAgentIds([]);
    }
  }, [open]);

  const editableIdsKey = editableAgents.map((agent) => agent.id).join(",");
  useEffect(() => {
    if (!open || !onLoadEnvironmentKeys || !editableAgents.length) return;
    let active = true;
    void onLoadEnvironmentKeys(editableAgents.map((agent) => agent.id))
      .then((keys) => {
        if (active) setEnvKeysByAgent(keys);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open, editableIdsKey, onLoadEnvironmentKeys]);

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.displayName])),
    [agents],
  );

  const previewPlan = useMemo(
    () =>
      planBatchRuntimePreview({
        agents,
        computerOnline,
        keepRuntime: draft?.keepRuntime ?? true,
        selection: draft?.selection,
        apiKey: draft?.apiKey ?? "",
        envPatch: draft?.envPatch ?? { set: {}, remove: [] },
        envKeysByAgent,
      }),
    [agents, computerOnline, draft, envKeysByAgent],
  );

  const handleFormSave = (form: FormData, changed: { runtime: boolean; environment: boolean }) => {
    const envPatch = parseBatchEnvPatch(envRowsFromForm(form), []);
    const keepRuntime = !changed.runtime && envPatch.hasAny;
    const { selection, apiKey } = selectionFromForm(form);
    setDraft({
      keepRuntime,
      selection: keepRuntime ? undefined : selection,
      apiKey: keepRuntime ? "" : apiKey,
      envPatch,
    });
    setRetryAgentIds([]);
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (!draft) return;
    const targetAgentIds =
      retryAgentIds.length > 0 ? retryAgentIds : editableAgents.map((agent) => agent.id);
    if (targetAgentIds.length === 0) return;
    setSaving(true);
    try {
      const payload: BatchUpdateAgentRuntimeConfigClientInput = {
        computerId,
        agentIds: targetAgentIds,
        ...(!draft.keepRuntime && draft.selection
          ? {
              runtime: {
                provider: draft.selection.provider,
                modelProvider: draft.selection.modelProvider || undefined,
                model: draft.selection.model,
                reasoning: draft.selection.reasoning,
                fastMode: draft.selection.fastMode === true,
                ...(draft.selection.contextWindow === undefined
                  ? {}
                  : { contextWindow: draft.selection.contextWindow }),
                ...(draft.selection.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: draft.selection.maxOutputTokens }),
                ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
              },
            }
          : {}),
        ...(draft.envPatch.hasAny
          ? { environmentPatch: { set: draft.envPatch.set, remove: draft.envPatch.remove } }
          : {}),
      };
      const result = await onSubmitBatch(payload);
      if (result.failed.length > 0) {
        setRetryAgentIds(result.failed.map((item) => item.agentId));
        if (result.succeeded.length > 0) onSaved(result);
        const detail = result.failed
          .map(
            (item) =>
              `${agentNameById.get(item.agentId) ?? item.agentId}: ${failureReasonMessage(item)}`,
          )
          .join("；");
        throw new PartialBatchFailureError(
          `${m.agent_batch_runtime_failed_heading({ count: result.failed.length })} ${detail}`,
        );
      }
      onSaved(result);
      setRetryAgentIds([]);
      setConfirmOpen(false);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const descriptionText = (() => {
    if (previewPlan.missingApiKey) return m.agent_form_api_key_required();
    if (previewPlan.changedCount === 0) return m.agent_batch_runtime_unchanged_notice();
    if (!computerOnline) return m.agent_batch_runtime_notice_offline();
    if (previewPlan.willRestartCount > 0) {
      return m.agent_batch_runtime_warning_restart({ restart: previewPlan.willRestartCount });
    }
    if (previewPlan.whenIdleCount > 0) return m.agent_batch_runtime_notice_when_idle();
    return m.agent_batch_runtime_notice_deferred();
  })();

  const confirmDisabled = previewPlan.changedCount === 0 || previewPlan.missingApiKey;

  return (
    <>
      <AgentRuntimeConfigDialog
        open={open}
        onClose={() => {
          setConfirmOpen(false);
          onOpenChange(false);
        }}
        computerId={computerId}
        credentialConfigured={editableAgents.every((agent) => agent.hasApiKey)}
        allowUnchangedSubmit={allowUnchangedSubmit}
        initial={initialSelection}
        onLoad={onLoadRuntimeOptions}
        environment={EMPTY_BATCH_ENVIRONMENT}
        saving={saving}
        error=""
        onSave={handleFormSave}
      />
      <ConfirmDialog
        open={open && confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="default"
        title={m.agent_batch_runtime_confirm_title({ count: previewPlan.changedCount })}
        description={
          <p className={previewPlan.missingApiKey ? "text-error-primary" : undefined}>
            {descriptionText}
          </p>
        }
        confirmDisabled={confirmDisabled}
        confirmLabel={
          retryAgentIds.length > 0
            ? m.agent_batch_runtime_retry_failed()
            : m.agent_batch_runtime_confirm_submit()
        }
        pendingLabel={m.agent_profile_saving()}
        errorMessage={(cause) =>
          cause instanceof PartialBatchFailureError ? cause.message : agentUpdateErrorMessage(cause)
        }
        onConfirm={handleConfirm}
      />
    </>
  );
}
