import { useEffect, useMemo, useState } from "react";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import type { BatchUpdateAgentRuntimeConfigClientInput } from "./agent.schemas";
import { agentUpdateErrorMessage, sizesFromForm } from "./agent-form";
import {
  AgentRuntimeConfigDialog,
  type AgentEnvironmentState,
} from "./agent-runtime-config-dialog";
import type { RuntimeOptions, RuntimeSelection } from "./agent-runtime-fields";
import {
  BatchAgentRuntimeConfirmDialog,
  type BatchRuntimeSaveResult,
} from "./batch-agent-runtime-confirm-dialog";
import {
  buildInitialBatchRuntimeSelection,
  hasHeterogeneousBatchRuntime,
  parseBatchEnvPatch,
  planBatchRuntimePreview,
  type BatchRuntimePreviewAgent,
  type ParsedBatchEnvPatch,
} from "./batch-runtime-config-model";
import { runtimeProviderLabel } from "./runtime-provider-display";

export type { BatchRuntimeSaveResult };

const EMPTY_BATCH_ENVIRONMENT: AgentEnvironmentState = { loaded: true, values: {} };

type PendingBatchDraft = {
  keepRuntime: boolean;
  selection: RuntimeSelection | undefined;
  apiKey: string;
  envPatch: ParsedBatchEnvPatch;
};

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
  const [submitError, setSubmitError] = useState("");
  const [failedItems, setFailedItems] = useState<BatchRuntimeSaveResult["failed"]>([]);

  useEffect(() => {
    if (!open) {
      setConfirmOpen(false);
      setDraft(undefined);
      setSubmitError("");
      setFailedItems([]);
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

  const targetModelDisplay =
    !draft || draft.keepRuntime || !draft.selection
      ? ""
      : `${runtimeProviderLabel(draft.selection.provider)}${draft.selection.model ? ` · ${draft.selection.model}` : ""}`;

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
    setSubmitError("");
    setFailedItems([]);
    setConfirmOpen(true);
  };

  const executeBatch = async (targetAgentIds: string[]) => {
    if (!draft || saving || targetAgentIds.length === 0) return;
    setSaving(true);
    setSubmitError("");
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
        setFailedItems(result.failed);
        if (result.succeeded.length > 0) onSaved(result);
        return;
      }
      onSaved(result);
      setConfirmOpen(false);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(agentUpdateErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const canConfirm = !saving && previewPlan.changedCount > 0 && !previewPlan.missingApiKey;

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
      <BatchAgentRuntimeConfirmDialog
        open={open && confirmOpen}
        onOpenChange={setConfirmOpen}
        computerOnline={computerOnline}
        previewPlan={previewPlan}
        targetModelDisplay={targetModelDisplay}
        agentNameById={agentNameById}
        failedItems={failedItems}
        submitError={submitError}
        saving={saving}
        canConfirm={canConfirm}
        onConfirm={() => void executeBatch(editableAgents.map((agent) => agent.id))}
        onRetryFailed={() => void executeBatch(failedItems.map((item) => item.agentId))}
      />
    </>
  );
}
