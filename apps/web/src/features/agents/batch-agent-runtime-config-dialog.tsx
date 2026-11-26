import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Select } from "#src/components/base/select/select";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { PHONE_PAGE_HEADER, PhoneFormBar } from "#src/components/ui/phone-form-bar";
import {
  UnsavedChangesDialog,
  useReportDirty,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import type { BatchUpdateAgentRuntimeConfigClientInput } from "./agent.schemas";
import { agentEnvironmentNameError, agentUpdateErrorMessage, sizesFromForm } from "./agent-form";
import {
  AgentRuntimeFields,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields";
import {
  BatchAgentRuntimeConfirmStep,
  type BatchRuntimeSaveResult,
} from "./batch-agent-runtime-confirm-step";
import { BatchAgentRuntimeEnvSection, type BatchEnvRow } from "./batch-agent-runtime-env-section";
import {
  buildInitialBatchRuntimeSelection,
  collectCommonEnvKeys,
  parseBatchEnvPatch,
  planBatchRuntimePreview,
  type BatchRuntimePreviewAgent,
} from "./batch-runtime-config-model";
import { runtimeProviderLabel } from "./runtime-provider-display";

export type { BatchRuntimeSaveResult };

type CapturedStepOneDraft = {
  keepRuntime: boolean;
  selection: RuntimeSelection | undefined;
  apiKey: string;
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

function BatchAgentRuntimeConfigBody({
  computerId,
  computerOnline,
  agents,
  initialOptions,
  onLoadRuntimeOptions,
  onLoadEnvironmentKeys,
  onSubmitBatch,
  onSaved,
  onClose,
  onDirtyChange,
}: {
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
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const controlSize = useDialogControlSize();
  const editableAgents = useMemo(
    () => agents.filter((agent) => agent.ownedByCurrentUser),
    [agents],
  );
  const excludedCount = agents.length - editableAgents.length;
  const fallbackProvider =
    parseRuntimeProvider(initialOptions?.providers[0]) ?? RUNTIME_PROVIDER.COFORGE;
  const initialSelection = useMemo(
    () => buildInitialBatchRuntimeSelection(agents, fallbackProvider),
    [agents, fallbackProvider],
  );

  const [step, setStep] = useState<1 | 2>(1);
  const [keepRuntime, setKeepRuntime] = useState(false);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [envDisclosureOpen, setEnvDisclosureOpen] = useState(false);
  const [envRows, setEnvRows] = useState<BatchEnvRow[]>([]);
  const [envRemoves, setEnvRemoves] = useState<string[]>([]);
  const [removeInput, setRemoveInput] = useState("");
  const [envKeysByAgent, setEnvKeysByAgent] = useState<Record<string, string[]> | undefined>(
    undefined,
  );
  const [captured, setCaptured] = useState<CapturedStepOneDraft>({
    keepRuntime: false,
    selection: initialSelection,
    apiKey: "",
  });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [failedItems, setFailedItems] = useState<BatchRuntimeSaveResult["failed"]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  const editableIdsKey = editableAgents.map((agent) => agent.id).join(",");
  useEffect(() => {
    if (!onLoadEnvironmentKeys || !editableAgents.length) return;
    let active = true;
    void onLoadEnvironmentKeys(editableAgents.map((agent) => agent.id))
      .then((keys) => {
        if (active) setEnvKeysByAgent(keys);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [editableIdsKey, onLoadEnvironmentKeys]);

  const parsedEnv = useMemo(() => parseBatchEnvPatch(envRows, envRemoves), [envRows, envRemoves]);
  const envKeyErrors = useMemo(
    () => envRows.map((row) => agentEnvironmentNameError(row.key)),
    [envRows],
  );
  const removeInputError = removeInput.trim() ? agentEnvironmentNameError(removeInput) : undefined;
  const hasEnvErrors =
    envKeyErrors.some(Boolean) || parsedEnv.conflictKeys.length > 0 || Boolean(removeInputError);
  const commonEnvKeys = useMemo(() => {
    if (!envKeysByAgent) return [];
    const removeSet = new Set(envRemoves);
    return collectCommonEnvKeys(envKeysByAgent).filter((entry) => !removeSet.has(entry.key));
  }, [envKeysByAgent, envRemoves]);

  const dirty = runtimeDirty || parsedEnv.hasAny || keepRuntime || step === 2;
  useReportDirty(dirty, onDirtyChange);

  const previewPlan = useMemo(
    () =>
      planBatchRuntimePreview({
        agents,
        computerOnline,
        keepRuntime: captured.keepRuntime,
        selection: captured.selection,
        apiKey: captured.apiKey,
        envPatch: { set: parsedEnv.set, remove: parsedEnv.remove },
        envKeysByAgent,
      }),
    [agents, computerOnline, captured, parsedEnv, envKeysByAgent],
  );

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.displayName])),
    [agents],
  );

  const commitRemoveKey = () => {
    const trimmed = removeInput.trim();
    if (!trimmed || agentEnvironmentNameError(trimmed)) return;
    if (!envRemoves.includes(trimmed)) setEnvRemoves([...envRemoves, trimmed]);
    setRemoveInput("");
  };

  const handleStepOneSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasEnvErrors) return;
    if (keepRuntime) {
      setCaptured({ keepRuntime: true, selection: undefined, apiKey: "" });
    } else {
      const { selection, apiKey } = selectionFromForm(new FormData(event.currentTarget));
      setCaptured({ keepRuntime: false, selection, apiKey });
    }
    setSubmitError("");
    setFailedItems([]);
    setStep(2);
  };

  const executeBatch = async (targetAgentIds: string[]) => {
    if (saving || targetAgentIds.length === 0) return;
    setSaving(true);
    setSubmitError("");
    try {
      const payload: BatchUpdateAgentRuntimeConfigClientInput = {
        computerId,
        agentIds: targetAgentIds,
        ...(!captured.keepRuntime && captured.selection
          ? {
              runtime: {
                provider: captured.selection.provider,
                modelProvider: captured.selection.modelProvider || undefined,
                model: captured.selection.model,
                reasoning: captured.selection.reasoning,
                fastMode: captured.selection.fastMode === true,
                ...(captured.selection.contextWindow === undefined
                  ? {}
                  : { contextWindow: captured.selection.contextWindow }),
                ...(captured.selection.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: captured.selection.maxOutputTokens }),
                ...(captured.apiKey ? { apiKey: captured.apiKey } : {}),
              },
            }
          : {}),
        ...(parsedEnv.hasAny
          ? { environmentPatch: { set: parsedEnv.set, remove: parsedEnv.remove } }
          : {}),
      };
      const result = await onSubmitBatch(payload);
      if (result.failed.length > 0) {
        setFailedItems(result.failed);
        if (result.succeeded.length > 0) onSaved(result);
        return;
      }
      onSaved(result);
      onClose();
    } catch (error) {
      setSubmitError(agentUpdateErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const stepHeaderDescription = (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-tertiary">
      <span className={step === 1 ? "font-semibold text-primary" : undefined}>
        {m.agent_batch_runtime_step_configure()}
      </span>
      <span aria-hidden="true">→</span>
      <span className={step === 2 ? "font-semibold text-primary" : undefined}>
        {m.agent_batch_runtime_step_confirm()}
      </span>
    </span>
  );

  if (step === 2) {
    const targetModelDisplay =
      captured.keepRuntime || !captured.selection
        ? ""
        : `${runtimeProviderLabel(captured.selection.provider)}${captured.selection.model ? ` · ${captured.selection.model}` : ""}`;
    const canConfirm =
      !saving && previewPlan.changedCount > 0 && !previewPlan.missingApiKey && !hasEnvErrors;
    return (
      <BatchAgentRuntimeConfirmStep
        computerOnline={computerOnline}
        previewPlan={previewPlan}
        targetModelDisplay={targetModelDisplay}
        stepHeaderDescription={stepHeaderDescription}
        agentNameById={agentNameById}
        failedItems={failedItems}
        submitError={submitError}
        saving={saving}
        canConfirm={canConfirm}
        onBack={() => setStep(1)}
        onClose={onClose}
        onConfirm={() => void executeBatch(editableAgents.map((agent) => agent.id))}
        onRetryFailed={() => void executeBatch(failedItems.map((item) => item.agentId))}
      />
    );
  }

  const canProceedStepOne =
    editableAgents.length > 0 && !hasEnvErrors && (!keepRuntime || parsedEnv.hasAny);

  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden max-sm:min-h-full"
      onSubmit={handleStepOneSubmit}
    >
      <PhoneFormBar
        heading={m.agent_batch_runtime_title({ count: editableAgents.length })}
        submitLabel={m.agent_batch_runtime_next({ count: editableAgents.length })}
        pending={false}
        submitDisabled={!canProceedStepOne}
        onCancel={onClose}
        onSubmit={() => formRef.current?.requestSubmit()}
      />
      <DialogHeader
        className={`${PHONE_PAGE_HEADER} shrink-0`}
        title={m.agent_batch_runtime_title({ count: editableAgents.length })}
        description={stepHeaderDescription}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-6 pb-2 max-sm:px-4 max-sm:pt-2 max-sm:pb-6">
        {excludedCount > 0 && (
          <p className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2 text-sm text-secondary">
            {m.agent_batch_runtime_excluded_notice({
              count: excludedCount,
              editable: editableAgents.length,
            })}
          </p>
        )}
        <Select
          label={m.agent_batch_runtime_mode_label()}
          size={controlSize}
          className="min-w-0"
          selectedKey={keepRuntime ? "keep" : "update"}
          onSelectionChange={(key) => {
            const nextKeep = key === "keep";
            setKeepRuntime(nextKeep);
            if (nextKeep) setEnvDisclosureOpen(true);
          }}
        >
          <Select.Item id="update" label={m.agent_batch_runtime_mode_update()} />
          <Select.Item id="keep" label={m.agent_batch_runtime_mode_keep()} />
        </Select>
        {!keepRuntime && (
          <AgentRuntimeFields
            key={computerId}
            open
            computerId={computerId}
            credentialConfigured={editableAgents.every((agent) => agent.hasApiKey)}
            initial={captured.selection ?? initialSelection}
            initialOptions={initialOptions}
            onLoad={onLoadRuntimeOptions}
            onDirtyChange={setRuntimeDirty}
          />
        )}
        <BatchAgentRuntimeEnvSection
          isExpanded={envDisclosureOpen}
          onExpandedChange={setEnvDisclosureOpen}
          envRows={envRows}
          onEnvRowsChange={setEnvRows}
          envKeyErrors={envKeyErrors}
          envRemoves={envRemoves}
          onEnvRemovesChange={setEnvRemoves}
          removeInput={removeInput}
          onRemoveInputChange={setRemoveInput}
          removeInputError={removeInputError}
          onCommitRemoveKey={commitRemoveKey}
          commonEnvKeys={commonEnvKeys}
          parsedEnv={parsedEnv}
        />
      </div>
      <DialogActions className="shrink-0 px-6 pt-4 pb-6 max-sm:hidden">
        <DialogCancel type="button" onPress={onClose}>
          {m.controls_cancel()}
        </DialogCancel>
        <DialogAction type="submit" isDisabled={!canProceedStepOne}>
          {m.agent_batch_runtime_next({ count: editableAgents.length })}
        </DialogAction>
      </DialogActions>
    </form>
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
  const [dirty, setDirty] = useState(false);
  const close = () => onOpenChange(false);
  const guard = useUnsavedChangesGuard({ overlayOpen: open, dirty, close });
  return (
    <>
      <ModalOverlay
        page
        isOpen={open}
        onOpenChange={(next: boolean) => {
          if (!next) guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-xl overflow-hidden">
          <Dialog className="flex flex-col overflow-hidden max-sm:h-full">
            {({ close: closeDialog }) => (
              <BatchAgentRuntimeConfigBody
                computerId={computerId}
                computerOnline={computerOnline}
                agents={agents}
                initialOptions={initialOptions}
                onLoadRuntimeOptions={onLoadRuntimeOptions}
                onLoadEnvironmentKeys={onLoadEnvironmentKeys}
                onSubmitBatch={onSubmitBatch}
                onSaved={onSaved}
                onClose={closeDialog}
                onDirtyChange={setDirty}
              />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
