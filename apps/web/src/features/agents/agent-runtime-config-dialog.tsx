import { useEffect, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { AlertCircle, ChevronDown, Trash01 } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { useAppForm } from "#src/components/ui/form";
import { Skeleton } from "#src/components/ui/skeleton";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { PHONE_PAGE_HEADER, PhoneFormBar } from "#src/components/ui/phone-form-bar";
import {
  UnsavedChangesDialog,
  useReportDirty,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import {
  ComputerStatusIcon,
  computerOptionClassName,
} from "#src/features/computers/computer-status-icon";
import { useCodexCompatibleSupportByComputer } from "#src/features/computers/use-codex-compatible-support";
import { fieldHint, scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import {
  codexCompatibleComputerIneligibility,
  codexCompatibleComputerIneligibilityLabel,
  type CodexCompatibleComputerCandidate,
} from "./codex-compatible-computer-eligibility";
import {
  agentEnvironmentNameError,
  agentEnvironmentRowsChanged,
  type AgentFormField,
} from "./agent-form";
import {
  AgentRuntimeFields,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields";

const MAX_ENV_ROWS = 64;

export type AgentEnvironmentState = {
  loaded: boolean;
  failed?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  values: Record<string, string>;
};

export type AgentRuntimeComputerOption = {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes?: CodexCompatibleComputerCandidate["runtimes"];
};

type EnvironmentRow = { key: string; value: string };

export function AgentRuntimeConfigForm({
  computerId,
  computers,
  computerLocked = false,
  credentialConfigured = false,
  allowUnchangedSubmit = false,
  initial,
  onLoad,
  environment,
  saving,
  error,
  fieldErrors,
  onFieldErrorClear,
  onClose,
  onDirtyChange,
  onSave,
}: {
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  allowUnchangedSubmit?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  fieldErrors?: Partial<Record<AgentFormField, string>>;
  onFieldErrorClear?: (field: AgentFormField) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  const controlSize = useDialogControlSize();
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [codexState, setCodexState] = useState({ isCodex: false, isCodexCompatible: false });
  const formRef = useRef<HTMLFormElement>(null);
  const seeded = useRef(false);
  const prevComputerError = useRef<string | undefined>(undefined);

  const form = useAppForm({
    defaultValues: {
      computerId: computerId || computers?.[0]?.id || "",
      envRows: [] as EnvironmentRow[],
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: () => {
      if (envKeyErrors.some(Boolean)) {
        scheduleFocusInvalidField(formRef.current);
        return;
      }
      if (!formRef.current) return;
      onSave(new FormData(formRef.current), {
        runtime: runtimeDirty || computerDirty,
        environment: envDirty,
      });
    },
  });

  const { selectedComputerId, envRows } = useStore(form.store, (state) => ({
    selectedComputerId: state.values.computerId,
    envRows: state.values.envRows,
  }));

  useEffect(() => {
    if (computerId) form.setFieldValue("computerId", computerId);
  }, [computerId, form]);

  const showComputerPicker = Boolean(computers && computers.length > 0);
  const codexCompatibleSupport = useCodexCompatibleSupportByComputer(
    computers?.map((computer) => computer.id) ?? [],
    showComputerPicker && !computerLocked && (codexState.isCodex || codexState.isCodexCompatible),
  );
  const computerOptions = (computers ?? []).map((computer) => ({
    computer,
    ineligibleReason: codexCompatibleComputerIneligibility(
      computer,
      codexCompatibleSupport.get(computer.id),
      codexState.isCodexCompatible,
    ),
  }));
  const disabledComputerKeys = new Set(
    computerOptions.flatMap((entry) => (entry.ineligibleReason ? [entry.computer.id] : [])),
  );

  useEffect(() => {
    if (!showComputerPicker) return;
    const nextError = fieldErrors?.computerId;
    if (nextError) {
      form.setFieldMeta("computerId", (prev) => ({
        ...prev,
        isTouched: true,
        errorMap: { ...prev.errorMap, onSubmit: nextError },
      }));
    } else if (prevComputerError.current && form.getFieldMeta("computerId")?.errorMap.onSubmit) {
      form.setFieldMeta("computerId", (prev) => ({
        ...prev,
        errorMap: { ...prev.errorMap, onSubmit: undefined },
      }));
    }
    prevComputerError.current = nextError;
  }, [fieldErrors?.computerId, form, showComputerPicker]);

  const firstFieldError = fieldErrors
    ? (Object.entries(fieldErrors).find(([, value]) => Boolean(value))?.[0] as
        | AgentFormField
        | undefined)
    : undefined;
  useEffect(() => {
    if (firstFieldError) scheduleFocusInvalidField(formRef.current, firstFieldError);
  }, [firstFieldError, fieldErrors]);

  useEffect(() => {
    if (!environment?.loaded || seeded.current) return;
    seeded.current = true;
    form.setFieldValue(
      "envRows",
      Object.entries(environment.values).map(([key, value]) => ({ key, value })),
    );
  }, [environment, form]);

  const envFailed = Boolean(environment?.failed && !environment.loaded);
  const envPending = environment !== undefined && !environment.loaded && !envFailed;
  const envDirty = !envFailed && agentEnvironmentRowsChanged(envRows, environment?.values ?? {});
  const envKeyErrors = envRows.map((row) => agentEnvironmentNameError(row.key));
  const computerDirty = Boolean(computers) && selectedComputerId !== (computerId || "");
  const dirty = runtimeDirty || envDirty || computerDirty;
  const canSubmit = dirty || allowUnchangedSubmit;
  useReportDirty(dirty, onDirtyChange);

  return (
    <form.AppForm>
      <form
        ref={formRef}
        className="flex min-h-0 flex-1 flex-col overflow-hidden max-sm:min-h-full max-sm:overflow-visible"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <PhoneFormBar
          heading={m.agent_profile_edit_runtime_config()}
          submitLabel={m.controls_save()}
          pending={saving}
          submitDisabled={
            !canSubmit || envPending || envKeyErrors.some(Boolean) || !selectedComputerId
          }
          onCancel={onClose}
          onSubmit={() => formRef.current?.requestSubmit()}
        />
        <DialogHeader
          className={`${PHONE_PAGE_HEADER} shrink-0`}
          title={m.agent_profile_edit_runtime_config()}
          onClose={onClose}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-6 pb-2 max-sm:overflow-visible max-sm:px-4 max-sm:pt-2 max-sm:pb-6">
          {showComputerPicker ? (
            <form.AppField name="computerId">
              {(field) => (
                <field.Select
                  isRequired
                  isDisabled={computerLocked || saving}
                  size={controlSize}
                  label={m.agent_form_computer()}
                  className="min-w-0"
                  disabledKeys={disabledComputerKeys}
                  onSelectionChange={() => {
                    setRuntimeDirty(true);
                    setCodexState({ isCodex: false, isCodexCompatible: false });
                    onFieldErrorClear?.("computerId");
                    onFieldErrorClear?.("provider");
                    onFieldErrorClear?.("modelProvider");
                    onFieldErrorClear?.("model");
                    onFieldErrorClear?.("baseUrl");
                    onFieldErrorClear?.("apiKey");
                  }}
                >
                  {computerOptions.map(({ computer, ineligibleReason }) => (
                    <Select.Item
                      key={computer.id}
                      id={computer.id}
                      isDisabled={Boolean(ineligibleReason)}
                      label={computer.displayName}
                      supportingText={
                        ineligibleReason
                          ? codexCompatibleComputerIneligibilityLabel(ineligibleReason)
                          : undefined
                      }
                      aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                      icon={
                        <ComputerStatusIcon computer={computer} online={Boolean(computer.online)} />
                      }
                      className={computerOptionClassName(Boolean(computer.online))}
                    />
                  ))}
                </field.Select>
              )}
            </form.AppField>
          ) : computerId ? (
            <input type="hidden" name="computerId" value={computerId} />
          ) : null}
          {selectedComputerId ? (
            <AgentRuntimeFields
              key={selectedComputerId}
              open
              computerId={selectedComputerId}
              credentialConfigured={credentialConfigured}
              initial={initial}
              providerError={fieldErrors?.provider}
              modelProviderError={fieldErrors?.modelProvider}
              modelError={fieldErrors?.model}
              baseUrlError={fieldErrors?.baseUrl}
              apiKeyError={fieldErrors?.apiKey}
              onFieldErrorClear={onFieldErrorClear}
              onLoad={onLoad}
              onDirtyChange={setRuntimeDirty}
              onCodexStateChange={setCodexState}
            />
          ) : (
            <p className="text-sm text-tertiary">{m.agent_form_computer_required()}</p>
          )}
          {environment !== undefined && (
            <Disclosure>
              <Button
                slot="trigger"
                type="button"
                color="tertiary"
                size="sm"
                className="w-max gap-1 px-0 text-xs font-medium text-tertiary"
                iconLeading={ChevronDown}
              >
                {m.agent_env_more()}
              </Button>
              <DisclosurePanel>
                <div className="grid gap-3 pt-3">
                  {envPending ? (
                    <div role="status" aria-label={m.agent_env_loading()} className="grid gap-2">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  ) : envFailed ? (
                    <EmptyState
                      size="card"
                      role="alert"
                      picture={<EmptyIcon icon={AlertCircle} size="card" />}
                      title={m.empty_agent_env_load_failed()}
                      primaryAction={
                        environment.onRetry ? (
                          <RetryButton
                            size="card"
                            isRetrying={environment.retrying}
                            onPress={environment.onRetry}
                          />
                        ) : undefined
                      }
                    />
                  ) : (
                    <>
                      <div className="grid gap-1">
                        <p className="text-xs font-medium text-tertiary">{m.agent_env_title()}</p>
                        <p className="text-sm text-tertiary">{m.agent_env_description()}</p>
                      </div>
                      <form.AppField name="envRows" mode="array">
                        {(field) => (
                          <>
                            {field.state.value.map((row, index) => (
                              <div key={index} className="flex min-w-0 items-start gap-2">
                                <Input
                                  name="envKey"
                                  size={controlSize}
                                  className="min-w-0 flex-1"
                                  placeholder={m.agent_env_key_placeholder()}
                                  isInvalid={Boolean(envKeyErrors[index])}
                                  hint={fieldHint(envKeyErrors[index])}
                                  value={row.key}
                                  onChange={(value) =>
                                    field.replaceValue(index, { ...row, key: value })
                                  }
                                />
                                <span
                                  aria-hidden="true"
                                  className="flex h-9 items-center text-tertiary"
                                >
                                  =
                                </span>
                                <Input
                                  name="envValue"
                                  size={controlSize}
                                  className="min-w-0 flex-1"
                                  placeholder={m.agent_env_value_placeholder()}
                                  value={row.value}
                                  onChange={(value) => field.replaceValue(index, { ...row, value })}
                                />
                                <div className="-me-1.5 flex h-9 items-center">
                                  <ButtonUtility
                                    type="button"
                                    size="xs"
                                    color="tertiary"
                                    icon={Trash01}
                                    aria-label={m.agent_env_remove_label({ index: index + 1 })}
                                    onClick={() => field.removeValue(index)}
                                  />
                                </div>
                              </div>
                            ))}
                            <Button
                              type="button"
                              color="secondary"
                              size="sm"
                              className="justify-self-start"
                              isDisabled={field.state.value.length >= MAX_ENV_ROWS}
                              onPress={() => field.pushValue({ key: "", value: "" })}
                            >
                              {m.agent_env_add()}
                            </Button>
                          </>
                        )}
                      </form.AppField>
                    </>
                  )}
                </div>
              </DisclosurePanel>
            </Disclosure>
          )}
          <form.Alert error={error} />
        </div>
        <DialogActions className="shrink-0 px-6 pt-4 pb-6 max-sm:hidden">
          <DialogCancel type="button" isDisabled={saving} onPress={onClose}>
            {m.controls_cancel()}
          </DialogCancel>
          <DialogAction
            type="submit"
            isDisabled={
              saving ||
              !canSubmit ||
              envPending ||
              envKeyErrors.some(Boolean) ||
              !selectedComputerId
            }
          >
            {saving ? m.agent_profile_saving() : m.agent_profile_save_runtime_config()}
          </DialogAction>
        </DialogActions>
      </form>
    </form.AppForm>
  );
}

export function AgentRuntimeConfigDialog({
  open,
  onClose,
  computerId,
  computers,
  computerLocked,
  credentialConfigured,
  allowUnchangedSubmit,
  initial,
  onLoad,
  environment,
  saving,
  error,
  fieldErrors,
  onFieldErrorClear,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  allowUnchangedSubmit?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  fieldErrors?: Partial<Record<AgentFormField, string>>;
  onFieldErrorClear?: (field: AgentFormField) => void;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard({ overlayOpen: open, dirty, close: onClose });
  return (
    <>
      <ModalOverlay
        page
        isOpen={open}
        onOpenChange={(next: boolean) => {
          if (saving) return;
          if (!next) guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-xl overflow-hidden">
          <Dialog className="flex flex-col overflow-hidden max-sm:h-auto max-sm:min-h-full max-sm:overflow-visible">
            {({ close }) => (
              <AgentRuntimeConfigForm
                computerId={computerId}
                computers={computers}
                computerLocked={computerLocked}
                credentialConfigured={credentialConfigured}
                allowUnchangedSubmit={allowUnchangedSubmit}
                initial={initial}
                onLoad={onLoad}
                environment={environment}
                saving={saving}
                error={error}
                fieldErrors={fieldErrors}
                onFieldErrorClear={onFieldErrorClear}
                onClose={close}
                onDirtyChange={setDirty}
                onSave={onSave}
              />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
