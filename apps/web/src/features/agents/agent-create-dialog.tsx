import { useEffect, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { useRouter } from "@tanstack/react-router";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  codexCompatibleBaseUrl,
  selectsCodexCompatible,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";

import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { localizeHref } from "#src/paraglide/runtime";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { AGENT_VISIBILITY } from "./agent-visibility";
import {
  agentCreateErrorTarget,
  agentCreateModelError,
  sizesFromForm,
  type AgentFormField,
} from "./agent-form";
import { AgentOptionCard } from "./agent-option-card";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import { AgentRuntimeSignInNotice } from "./agent-runtime-sign-in-notice";
import type { RuntimeSignInComputer } from "./agent-runtime-sign-in-state";
import { RuntimeSignInDialog } from "#src/features/computers/runtime-sign-in-dialog";
import { useCodexCompatibleSupportByComputer } from "#src/features/computers/use-codex-compatible-support";
import { useRuntimeAuthSignals } from "#src/features/computers/use-runtime-auth-signals";
import { runtimeProviderLabel } from "./runtime-provider-display";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField, type AgentUsernameDraft } from "./agent-username-field";
import type { CreateAgentInput } from "./agent.schemas";
import { preferredRuntimeProvider, runtimeOptionsFromRuntimes } from "./agent-runtime-options";
import {
  AgentCreateComputerSelect,
  AgentCreateEmptyComputers,
  AgentCreateFooter,
  AgentCreateForm,
  AgentCreateIntro,
  AgentCreateModal,
} from "./agent-create-frame";
import type {
  RuntimeAuthProvider,
  RuntimeProvider,
  RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import { workspacePath } from "#src/features/workspaces/workspace-url";

type AgentCreateComputerOption = RuntimeSignInComputer & {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: {
    provider: RuntimeProvider;
    unavailableCode?: RuntimeUnavailableCode | null;
    diagnostic?: string | null;
  }[];
};

const AGENT_FORM_FIELDS: readonly AgentFormField[] = [
  "name",
  "computerId",
  "provider",
  "modelProvider",
  "model",
  "baseUrl",
  "apiKey",
];

function preferredRuntime(computer: AgentCreateComputerOption | undefined) {
  const { providers } = runtimeOptionsFromRuntimes(computer?.runtimes ?? []);
  const provider = preferredRuntimeProvider(providers);
  return provider && { provider, modelProvider: "", model: "", reasoning: "" };
}

type LocalAgentFormOptions = {
  computers: AgentCreateComputerOption[];
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  cachedRuntimeCatalog?: (computerId: string) => RuntimeCatalog[] | undefined;
  defaults?: { name?: string; description?: string; computerId?: string };
  computerLocked?: boolean;
  visibilityLocked?: boolean;
  joinsChannelName?: string;
  nameNote?: string;
  actionCardMessageId?: string;
  usernameDraft?: AgentUsernameDraft;
};

export function LocalAgentForm({
  computers,
  onCreate,
  onLoadRuntimeCatalog,
  cachedRuntimeCatalog,
  defaults,
  computerLocked = false,
  visibilityLocked = false,
  joinsChannelName,
  nameNote,
  actionCardMessageId,
  usernameDraft,
  submitLabel = m.agent_form_submit(),
  onClose,
  headless = false,
  onBusyChange,
}: LocalAgentFormOptions & {
  onCreate: (input: CreateAgentInput) => Promise<void>;
  submitLabel?: string;
  onClose: () => void;
  headless?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const controlSize = useDialogControlSize();
  const [submitting, guard] = useSubmitGuard();
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState("");
  const [initialComputerId] = useState(defaults?.computerId ?? computers[0]?.id ?? "");
  const [runtimeChanged, setRuntimeChanged] = useState(false);
  const [codexState, setCodexState] = useState({ isCodex: false, isCodexCompatible: false });
  const [signingIn, setSigningIn] = useState<RuntimeAuthProvider>();
  const [signedIn, setSignedIn] = useState<ReadonlySet<string>>(new Set());
  const codexCompatibleSupport = useCodexCompatibleSupportByComputer(
    computers.map((candidate) => candidate.id),
    !computerLocked && (codexState.isCodex || codexState.isCodexCompatible),
  );

  const form = useAppForm({
    defaultValues: {
      name: defaults?.name ?? "",
      computerId: initialComputerId,
      description: defaults?.description ?? "",
      provider: "",
      modelProvider: "",
      model: "",
      baseUrl: "",
      apiKey: "",
      isPrivate: false,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      setError("");
      for (const field of AGENT_FORM_FIELDS) clearFieldError(field);
      const formData = formRef.current ? new FormData(formRef.current) : new FormData();
      const name = finishedAgentUsername(String(formData.get("name") ?? ""));
      const description = value.description.trim();
      const provider = parseRuntimeProvider(formData.get("provider")) ?? RUNTIME_PROVIDER.COFORGE;
      const model = String(formData.get("model") ?? "").trim();
      const modelProvider = String(formData.get("modelProvider") ?? "").trim();
      const baseUrl = String(formData.get("baseUrl") ?? "").trim();
      const apiKey = String(formData.get("apiKey") ?? "").trim();
      if (!name) {
        setFieldServerError(form, "name", m.agent_form_username_required(), formRef.current);
        return;
      }
      const nextModelError = agentCreateModelError(provider, model, modelProvider);
      if (nextModelError) {
        setFieldServerError(form, "model", nextModelError, formRef.current);
        return;
      }
      if (selectsCodexCompatible(provider, modelProvider)) {
        if (!codexCompatibleBaseUrl(baseUrl)) {
          setFieldServerError(
            form,
            "baseUrl",
            m.agent_form_codex_compatible_endpoint_required(),
            formRef.current,
          );
          return;
        }
        if (apiKey.length < 8) {
          setFieldServerError(
            form,
            "apiKey",
            m.agent_form_codex_compatible_key_required(),
            formRef.current,
          );
          return;
        }
      }
      await guard(async () => {
        try {
          await onCreate({
            name,
            description,
            provider,
            model: model || undefined,
            modelProvider: modelProvider || undefined,
            reasoning: String(formData.get("reasoning") ?? "").trim(),
            fastMode: formData.get("fastMode") === "true",
            ...sizesFromForm(formData),
            apiKey: apiKey || undefined,
            baseUrl: baseUrl || undefined,
            computerId: computerLocked
              ? value.computerId
              : String(formData.get("computerId") ?? value.computerId),
            actionCardMessageId,
            visibility: value.isPrivate ? AGENT_VISIBILITY.PRIVATE : AGENT_VISIBILITY.PUBLIC,
          });
        } catch (cause) {
          const target = agentCreateErrorTarget(cause);
          if (target.field) {
            setFieldServerError(form, target.field, target.message, formRef.current);
          } else {
            setError(target.message);
          }
        }
      });
    },
  });

  function clearFieldError(field: AgentFormField) {
    if (!form.getFieldMeta(field)?.errorMap.onSubmit) return;
    form.setFieldMeta(field, (prev) => ({
      ...prev,
      errorMap: { ...prev.errorMap, onSubmit: undefined },
    }));
  }

  const { computerId, isPrivate } = useStore(form.store, (state) => ({
    computerId: state.values.computerId,
    isPrivate: state.values.isPrivate,
  }));

  useRuntimeAuthSignals(computerId, {
    onSubscribed: () => {},
    onSignal: (signal) => {
      if (signal.type === REALTIME_EVENTS.runtimeAuthLogin && signal.result?.kind === "logged_in")
        setSignedIn((current) => new Set(current).add(`${signal.computerId}:${signal.provider}`));
    },
  });
  const computer = computers.find((candidate) => candidate.id === computerId);
  const cachedCatalog = cachedRuntimeCatalog?.(computerId);
  const runtimeOptionsFor = (id: string, catalogs: RuntimeCatalog[]) => ({
    ...runtimeOptionsFromRuntimes(
      computers.find((candidate) => candidate.id === id)?.runtimes ?? [],
    ),
    catalogs,
  });
  useEffect(() => {
    onBusyChange(submitting);
    return () => onBusyChange(false);
  }, [submitting, onBusyChange]);

  if (!computers.length)
    return (
      <AgentCreateEmptyComputers
        headless={headless}
        workspaceSlug={workspaceSlug}
        onClose={onClose}
      />
    );

  return (
    <>
      <form.AppForm>
        <AgentCreateForm
          formRef={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          changed={computerId !== initialComputerId || isPrivate || runtimeChanged}
          intro={
            !headless && (
              <AgentCreateIntro
                illustration="local"
                title={m.agent_create_local_title()}
                description={m.agent_create_local_description()}
                onClose={submitting ? undefined : onClose}
              />
            )
          }
          footer={
            <AgentCreateFooter
              onCancel={onClose}
              cancelDisabled={submitting}
              submitLabel={submitLabel}
              submitting={submitting}
            />
          }
        >
          <div className="flex flex-col gap-4 px-6 pt-5 pb-3">
            {joinsChannelName && (
              <p className="text-sm text-secondary">
                {m.agent_form_joins_channel({ channel: joinsChannelName })}
              </p>
            )}
            <form.AppField name="name">
              {(field) => (
                <AgentUsernameField
                  defaultValue={defaults?.name}
                  note={nameNote}
                  error={visibleFieldError(field.state.meta, field.form.state.submissionAttempts)}
                  onErrorClear={() => clearFieldError("name")}
                  draft={usernameDraft}
                />
              )}
            </form.AppField>
            <form.AppField name="computerId">
              {(field) => (
                <AgentCreateComputerSelect
                  computers={computers}
                  computerLocked={computerLocked}
                  computerError={visibleFieldError(
                    field.state.meta,
                    field.form.state.submissionAttempts,
                  )}
                  controlSize={controlSize}
                  selectedKey={field.state.value}
                  codexCompatibleMode={codexState.isCodexCompatible}
                  codexCompatibleSupport={codexCompatibleSupport}
                  onAddComputer={() => {
                    onClose();
                    void router.navigate({
                      href: localizeHref(workspacePath(workspaceSlug, "/computers?add=1")),
                    });
                  }}
                  onSelectComputer={(id) => {
                    clearFieldError("computerId");
                    clearFieldError("provider");
                    clearFieldError("modelProvider");
                    clearFieldError("model");
                    clearFieldError("baseUrl");
                    clearFieldError("apiKey");
                    setCodexState({ isCodex: false, isCodexCompatible: false });
                    field.handleChange(id);
                  }}
                />
              )}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextArea
                  label={m.agent_create_description()}
                  size={controlSize}
                  rows={3}
                  placeholder={m.agent_form_description_placeholder()}
                  className="min-w-0"
                  textAreaClassName="field-sizing-content max-h-40 min-h-20"
                />
              )}
            </form.AppField>
            <form.AppField name="provider">
              {(providerField) => (
                <form.AppField name="modelProvider">
                  {(modelProviderField) => (
                    <form.AppField name="model">
                      {(modelField) => (
                        <form.AppField name="baseUrl">
                          {(baseUrlField) => (
                            <form.AppField name="apiKey">
                              {(apiKeyField) => {
                                const attempts = providerField.form.state.submissionAttempts;
                                return (
                                  <AgentRuntimeFields
                                    key={computerId}
                                    open
                                    computerId={computerId}
                                    initial={preferredRuntime(computer)}
                                    enforceRequiredModel
                                    providerError={visibleFieldError(
                                      providerField.state.meta,
                                      attempts,
                                    )}
                                    modelProviderError={visibleFieldError(
                                      modelProviderField.state.meta,
                                      attempts,
                                    )}
                                    modelError={visibleFieldError(modelField.state.meta, attempts)}
                                    baseUrlError={visibleFieldError(
                                      baseUrlField.state.meta,
                                      attempts,
                                    )}
                                    apiKeyError={visibleFieldError(
                                      apiKeyField.state.meta,
                                      attempts,
                                    )}
                                    onModelErrorClear={() => clearFieldError("model")}
                                    onFieldErrorClear={clearFieldError}
                                    onDirtyChange={setRuntimeChanged}
                                    onCodexStateChange={setCodexState}
                                    providerNotice={({
                                      provider,
                                      modelProvider,
                                      codexCompatibleSupported,
                                      onUseCodexCompatible,
                                    }) =>
                                      computer &&
                                      !signedIn.has(`${computerId}:${provider}`) && (
                                        <AgentRuntimeSignInNotice
                                          computer={computer}
                                          provider={provider}
                                          modelProvider={modelProvider}
                                          codexCompatibleSupported={codexCompatibleSupported}
                                          onUseCodexCompatible={onUseCodexCompatible}
                                          onSignIn={setSigningIn}
                                        />
                                      )
                                    }
                                    onLoad={async (id) =>
                                      runtimeOptionsFor(id, await onLoadRuntimeCatalog(id))
                                    }
                                    initialOptions={
                                      cachedCatalog && runtimeOptionsFor(computerId, cachedCatalog)
                                    }
                                  />
                                );
                              }}
                            </form.AppField>
                          )}
                        </form.AppField>
                      )}
                    </form.AppField>
                  )}
                </form.AppField>
              )}
            </form.AppField>
            <form.AppField name="isPrivate">
              {(field) => (
                <AgentOptionCard
                  label={m.agent_form_visibility_private()}
                  isDisabled={visibilityLocked}
                  isSelected={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </form.AppField>
            <form.Alert error={error} />
          </div>
        </AgentCreateForm>
      </form.AppForm>
      {signingIn && computer && (
        <RuntimeSignInDialog
          computerId={computer.id}
          computerName={computer.displayName}
          provider={signingIn}
          runtimeName={runtimeProviderLabel(signingIn)}
          onClose={() => setSigningIn(undefined)}
        />
      )}
    </>
  );
}

export function AgentCreateDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
  ...options
}: LocalAgentFormOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onCreated?: (result: { startPublished: boolean }) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AgentCreateModal
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!busy}
      title={m.agent_create_local_title()}
    >
      <LocalAgentForm
        {...options}
        onCreate={async (input) => {
          const result = await onCreate(input);
          onOpenChange(false);
          onCreated?.(result);
        }}
        onClose={() => onOpenChange(false)}
        onBusyChange={setBusy}
      />
    </AgentCreateModal>
  );
}
