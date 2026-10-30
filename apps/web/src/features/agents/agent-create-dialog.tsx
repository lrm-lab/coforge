import { useEffect, useState, type FormEvent } from "react";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { localizeHref } from "#src/paraglide/runtime";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { StatusDot } from "#src/components/ui/status-dot";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { AGENT_VISIBILITY } from "./agent-visibility";
import { agentCreateErrorMessage } from "./agent-form";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField } from "./agent-username-field";
import type { CreateAgentInput } from "./agent.schemas";
import { runtimeOptionsFromRuntimes } from "./agent-runtime-options";
import {
  AgentCreateFooter,
  AgentCreateForm,
  AgentCreateIntro,
  AgentCreateModal,
} from "./agent-create-frame";
import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";
import { workspacePath } from "#src/features/workspaces/workspace-url";

type AgentCreateComputerOption = {
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

type LocalAgentFormOptions = {
  computers: AgentCreateComputerOption[];
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  defaults?: { name?: string; description?: string; computerId?: string };
  computerLocked?: boolean;
  visibilityLocked?: boolean;
  joinsChannelName?: string;
  nameNote?: string;
  actionCardMessageId?: string;
};

/** The Agent-create form for an Agent on a connected Computer, the local half of the new-Agent
 * dialog. `defaults` prefills it; `computerLocked` mirrors an action card's `requiredComputer` by
 * disabling the Computer selector; `visibilityLocked` keeps the Agent public, for a caller that
 * adds it to a channel, and `joinsChannelName` says which channel that is. `nameNote` explains a
 * prefilled name. `onCreate` resolves once the caller has done what follows a create. */
export function LocalAgentForm({
  computers,
  onCreate,
  onLoadRuntimeCatalog,
  defaults,
  computerLocked = false,
  visibilityLocked = false,
  joinsChannelName,
  nameNote,
  actionCardMessageId,
  submitLabel = m.agent_form_submit(),
  onClose,
  onSwitchToCloud,
  onBusyChange,
}: LocalAgentFormOptions & {
  onCreate: (input: CreateAgentInput) => Promise<void>;
  submitLabel?: string;
  onClose: () => void;
  onSwitchToCloud?: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [submitting, guard] = useSubmitGuard();
  const workspaceSlug = useWorkspaceSlug();
  const [error, setError] = useState("");
  const [computerId, setComputerId] = useState(defaults?.computerId ?? computers[0]?.id ?? "");
  const [isPrivate, setIsPrivate] = useState(false);
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
      setError(m.agent_form_required_error());
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
        <AgentCreateIntro
          icon={Monitor}
          title={m.agent_create_local_title()}
          description={m.agent_empty_computer_description()}
          onClose={onClose}
        />
        <div className="grid grid-cols-2 gap-3 px-6 pt-8 pb-6">
          <Button color="secondary" size="lg" onPress={onClose}>
            {m.controls_cancel()}
          </Button>
          <Button
            size="lg"
            href={localizeHref(workspacePath(workspaceSlug, "/computers?add=1"))}
            onPress={onClose}
          >
            {m.agent_connect_computer()}
          </Button>
        </div>
        {onSwitchToCloud && (
          <div className="-mt-2 px-6 pb-6 text-center">
            <Button color="link-color" size="sm" onPress={onSwitchToCloud}>
              {m.agent_create_switch_cloud()}
            </Button>
          </div>
        )}
      </>
    );

  return (
    <AgentCreateForm
      onSubmit={submit}
      switchTo={
        onSwitchToCloud && {
          label: m.agent_create_switch_cloud(),
          onPress: onSwitchToCloud,
          isDisabled: submitting,
        }
      }
      intro={
        <AgentCreateIntro
          icon={Monitor}
          title={m.agent_create_local_title()}
          description={m.agent_create_local_description()}
          onClose={submitting ? undefined : onClose}
        />
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
      <div className="grid gap-5 px-6 pt-5 pb-4">
        {joinsChannelName && (
          <p className="text-sm text-secondary">
            {m.agent_form_joins_channel({ channel: joinsChannelName })}
          </p>
        )}
        <AgentUsernameField
          label={m.agent_create_local_name()}
          defaultValue={defaults?.name}
          note={nameNote}
        />
        <Select
          name="computerId"
          isRequired
          hideRequiredIndicator
          isDisabled={computerLocked}
          size="md"
          label={m.agent_create_computer()}
          className="min-w-0"
          selectedKey={computerId}
          onSelectionChange={(key) => {
            if (key !== null) setComputerId(String(key));
          }}
        >
          {computers.map((computer) => (
            <Select.Item
              key={computer.id}
              id={computer.id}
              label={computer.displayName}
              aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
              icon={
                <StatusDot
                  tone={computer.online ? "online" : "offline"}
                  label={computer.online ? m.computer_status_online() : m.computer_status_offline()}
                  className="size-2"
                />
              }
            />
          ))}
        </Select>
        <TextArea
          label={m.agent_create_description()}
          name="description"
          rows={3}
          defaultValue={defaults?.description}
          placeholder={m.agent_form_description_placeholder()}
          className="min-w-0"
        />
        <AgentRuntimeFields
          key={computerId}
          open
          computerId={computerId}
          onLoad={async (id) => ({
            ...runtimeOptionsFromRuntimes(
              computers.find((computer) => computer.id === id)?.runtimes ?? [],
            ),
            catalogs: await onLoadRuntimeCatalog(id),
          })}
        />
        <Checkbox
          label={m.agent_form_visibility_private()}
          isDisabled={visibilityLocked}
          isSelected={isPrivate}
          onChange={setIsPrivate}
        />
        {/* A plain alert, not `HintText`: outside a field its "errorMessage" slot is not
            one the enclosing Dialog offers, and rendering it crashes the page. */}
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
    </AgentCreateForm>
  );
}

/** The local Agent-create form on its own, for callers that already know where the Agent goes: a
 * channel's Add members, a Computer's page, an `agent:create` action card. */
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
    <AgentCreateModal open={open} onOpenChange={onOpenChange} dismissable={!busy}>
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
