import { useEffect, useState, type FormEvent } from "react";
import { Plus } from "@untitledui/icons";
import { useRouter } from "@tanstack/react-router";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { localizeHref } from "#src/paraglide/runtime";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { StatusDot } from "#src/components/ui/status-dot";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { AGENT_VISIBILITY } from "./agent-visibility";
import { agentCreateErrorMessage, sizesFromForm } from "./agent-form";
import { AgentOptionCard } from "./agent-option-card";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import { AgentRuntimeSignInNotice } from "./agent-runtime-sign-in-notice";
import type { RuntimeSignInComputer } from "./agent-runtime-sign-in-state";
import { RuntimeSignInDialog } from "#src/features/computers/runtime-sign-in-dialog";
import { useRuntimeAuthSignals } from "#src/features/computers/use-runtime-auth-signals";
import { runtimeProviderLabel } from "./runtime-provider-display";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField, type AgentUsernameDraft } from "./agent-username-field";
import type { CreateAgentInput } from "./agent.schemas";
import { preferredRuntimeProvider, runtimeOptionsFromRuntimes } from "./agent-runtime-options";
import {
  AgentCreateFooter,
  AgentCreateForm,
  AgentCreateIntro,
  AgentCreateModal,
  AgentCreatePhoneBar,
} from "./agent-create-frame";
import type {
  RuntimeAuthProvider,
  RuntimeProvider,
  RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import { workspacePath } from "#src/features/workspaces/workspace-url";

type AgentCreateComputerOption = RuntimeSignInComputer & {
  id: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: {
    provider: RuntimeProvider;
    unavailableCode?: RuntimeUnavailableCode | null;
    diagnostic?: string | null;
  }[];
};

const ADD_COMPUTER_KEY = "\u0000add-computer";

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
  const [error, setError] = useState("");
  const [initialComputerId] = useState(defaults?.computerId ?? computers[0]?.id ?? "");
  const [computerId, setComputerId] = useState(initialComputerId);
  const [isPrivate, setIsPrivate] = useState(false);
  const [runtimeChanged, setRuntimeChanged] = useState(false);
  const [signingIn, setSigningIn] = useState<RuntimeAuthProvider>();
  const [signedIn, setSignedIn] = useState<ReadonlySet<string>>(new Set());
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const name = finishedAgentUsername(String(form.get("name") ?? ""));
    const description = String(form.get("description") ?? "").trim();
    if (!name) {
      setError(m.agent_form_username_required());
      return;
    }
    await guard(async () => {
      try {
        await onCreate({
          name,
          description,
          provider: parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE,
          model: String(form.get("model") ?? "").trim() || undefined,
          modelProvider: String(form.get("modelProvider") ?? "").trim() || undefined,
          reasoning: String(form.get("reasoning") ?? "").trim(),
          fastMode: form.get("fastMode") === "true",
          ...sizesFromForm(form),
          apiKey: String(form.get("apiKey") ?? "").trim() || undefined,
          computerId: computerLocked ? computerId : String(form.get("computerId") ?? ""),
          actionCardMessageId,
          visibility: isPrivate ? AGENT_VISIBILITY.PRIVATE : AGENT_VISIBILITY.PUBLIC,
        });
      } catch (cause) {
        setError(agentCreateErrorMessage(cause));
      }
    });
  }

  if (!computers.length)
    return (
      <>
        {headless ? (
          <p className="px-6 pt-5 text-sm text-tertiary">{m.agent_empty_computer_description()}</p>
        ) : (
          <AgentCreateIntro
            illustration="local"
            title={m.agent_create_local_title()}
            description={m.agent_empty_computer_description()}
            onClose={onClose}
          />
        )}
        <AgentCreatePhoneBar pending={false} onCancel={onClose} />
        <DialogActions className="mt-6 px-6 pb-6 max-sm:mt-4 max-sm:px-4">
          <DialogCancel onPress={onClose} className="max-sm:hidden">
            {m.controls_cancel()}
          </DialogCancel>
          <DialogAction
            href={localizeHref(workspacePath(workspaceSlug, "/computers?add=1"))}
            onPress={onClose}
          >
            {m.agent_connect_computer()}
          </DialogAction>
        </DialogActions>
      </>
    );

  return (
    <>
      <AgentCreateForm
        onSubmit={submit}
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
          <AgentUsernameField defaultValue={defaults?.name} note={nameNote} draft={usernameDraft} />
          <Select
            name="computerId"
            isRequired
            hideRequiredIndicator
            isDisabled={computerLocked}
            size={controlSize}
            label={m.agent_create_computer()}
            className="min-w-0"
            selectedKey={computerId}
            onSelectionChange={(key) => {
              if (key === ADD_COMPUTER_KEY) {
                onClose();
                void router.navigate({
                  href: localizeHref(workspacePath(workspaceSlug, "/computers?add=1")),
                });
                return;
              }
              if (key !== null) setComputerId(String(key));
            }}
          >
            {computers.map((computer) => (
              <Select.Item
                key={computer.id}
                id={computer.id}
                label={computer.displayName.trim() || computer.name}
                aria-label={`${computer.displayName.trim() || computer.name}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                icon={
                  <StatusDot
                    tone={computer.online ? "online" : "offline"}
                    label={
                      computer.online ? m.computer_status_online() : m.computer_status_offline()
                    }
                    className="size-2"
                  />
                }
              />
            ))}
            {!computerLocked && (
              <Select.Item
                id={ADD_COMPUTER_KEY}
                label={m.agent_create_add_computer()}
                icon={Plus}
                selectionIndicator="none"
                className="mt-1 border-t border-secondary pt-1"
              />
            )}
          </Select>
          <TextArea
            label={m.agent_create_description()}
            name="description"
            size={controlSize}
            rows={3}
            defaultValue={defaults?.description}
            placeholder={m.agent_form_description_placeholder()}
            className="min-w-0"
            textAreaClassName="field-sizing-content max-h-40 min-h-20"
          />
          <AgentRuntimeFields
            key={computerId}
            open
            computerId={computerId}
            initial={preferredRuntime(computer)}
            onDirtyChange={setRuntimeChanged}
            providerNotice={(provider) =>
              computer &&
              !signedIn.has(`${computerId}:${provider}`) && (
                <AgentRuntimeSignInNotice
                  computer={computer}
                  provider={provider}
                  onSignIn={setSigningIn}
                />
              )
            }
            onLoad={async (id) => runtimeOptionsFor(id, await onLoadRuntimeCatalog(id))}
            initialOptions={cachedCatalog && runtimeOptionsFor(computerId, cachedCatalog)}
          />
          <AgentOptionCard
            label={m.agent_form_visibility_private()}
            isDisabled={visibilityLocked}
            isSelected={isPrivate}
            onChange={setIsPrivate}
          />
          {error && (
            <p role="alert" className="text-sm text-error-primary">
              {error}
            </p>
          )}
        </div>
      </AgentCreateForm>
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
