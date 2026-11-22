import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, DotsHorizontal, Plus, RefreshCw01, Trash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { Fold } from "#src/components/ui/fold";
import { RelativeTime } from "#src/components/ui/relative-time";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  createExternalAgentPageCredential,
  revokeExternalAgentCredential,
} from "#src/features/agents/external-agent-credentials.functions";
import {
  ExternalAgentCredentialBlock,
  ExternalAgentPromptBlock,
  ExternalConnectionState,
  ExternalSetupStep,
  type ExternalSetup,
} from "#src/features/agents/external-agent-setup";
import { externalCredentialErrorMessage } from "#src/features/agents/external-agent-credential-error";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

export type ExternalCredentialSummary = {
  id: string;
  source: "device" | "app";
  machineName: string | null;
  hostname: string | null;
  os: string | null;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
};

function credentialLabel(credential: ExternalCredentialSummary): string {
  if (credential.source === "app") return m.external_agent_credential_from_page();
  return credential.machineName || credential.hostname || m.external_agent_credential_from_login();
}

export function ExternalAgentAccessSection({
  agentId,
  agentName,
  displayName,
  workspaceSlug,
  setup,
  connectTarget,
  credentials,
  timeZone,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  displayName: string;
  workspaceSlug: string | null;
  setup: ExternalSetup;
  connectTarget: string | null;
  credentials: readonly ExternalCredentialSummary[];
  timeZone: string | null;
  onChanged?: () => Promise<void> | void;
}) {
  const createCredential = useServerFn(createExternalAgentPageCredential);
  const revoke = useServerFn(revokeExternalAgentCredential);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const connected = setup.state === "online" || setup.state === "offline";
  const [stepsOpen, setStepsOpen] = useState(!connected);
  const pageCredential = credentials.find((credential) => credential.source === "app");

  async function issue() {
    const created = await createCredential({ data: { agentId } });
    setFreshKey(created.key);
    setStepsOpen(true);
    await onChanged?.();
  }

  async function createFirst() {
    setCreating(true);
    setCreateError(null);
    try {
      await issue();
    } catch (cause) {
      setCreateError(externalCredentialErrorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  const steps = workspaceSlug ? (
    <div className="space-y-4">
      <ExternalSetupStep title={m.external_agent_prompt_label()}>
        <ExternalAgentPromptBlock
          workspaceSlug={workspaceSlug}
          agentName={agentName}
          me={connectTarget}
        />
      </ExternalSetupStep>
      {freshKey ? (
        <ExternalSetupStep title={m.external_agent_credential_label()}>
          <ExternalAgentCredentialBlock credentialKey={freshKey} agentName={agentName} />
        </ExternalSetupStep>
      ) : null}
      {!freshKey && !connected && !pageCredential ? (
        <Button
          type="button"
          size="sm"
          color="secondary"
          iconLeading={Plus}
          isLoading={creating}
          onPress={() => void createFirst()}
        >
          {m.external_agent_credential_create()}
        </Button>
      ) : null}
      {createError ? (
        <p role="alert" className="text-sm text-error-primary">
          {createError}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <section className="border-b border-secondary px-6 py-5" data-testid="external-agent-setup">
      <p className={SECTION_CAPTION_CLASS}>{m.external_agent_setup_section()}</p>
      <div className="mt-3 space-y-3">
        <ExternalConnectionState
          setup={setup}
          displayName={displayName}
          timeZone={timeZone}
          hasCredential={credentials.length > 0 || freshKey !== null}
        />
        {connected && steps ? (
          <div>
            <Button
              size="sm"
              color="link-gray"
              aria-expanded={stepsOpen}
              iconTrailing={
                <ChevronDown
                  aria-hidden="true"
                  className={cx(
                    "size-3.5 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
                    stepsOpen && "rotate-180",
                  )}
                />
              }
              onPress={() => setStepsOpen((open) => !open)}
            >
              {m.external_agent_how_it_connects()}
            </Button>
            <Fold open={stepsOpen}>
              <div className="pt-3">{steps}</div>
            </Fold>
          </div>
        ) : (
          steps
        )}
      </div>

      {credentials.length > 0 ? (
        <div className="mt-5">
          <p className={SECTION_CAPTION_CLASS}>{m.external_agent_credentials_section()}</p>
          <ul className="mt-2 divide-y divide-secondary">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                data-testid="external-agent-credential-row"
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">
                    {credentialLabel(credential)}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-tertiary">
                    <span className="truncate">
                      {m.external_agent_credential_created()}{" "}
                      <RelativeTime value={credential.createdAt} timeZone={timeZone} />
                    </span>
                    <span className="truncate">
                      {credential.lastUsedAt ? (
                        <>
                          {m.external_agent_credential_last_used()}{" "}
                          <RelativeTime value={credential.lastUsedAt} timeZone={timeZone} />
                        </>
                      ) : (
                        m.external_agent_credential_not_used()
                      )}
                    </span>
                  </p>
                </div>
                <CredentialMenu
                  replaceable={credential === pageCredential}
                  displayName={displayName}
                  onReplace={issue}
                  onRevoke={async () => {
                    await revoke({ data: { agentId, credentialId: credential.id } });
                    if (credential === pageCredential) setFreshKey(null);
                    await onChanged?.();
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function CredentialMenu({
  replaceable,
  displayName,
  onReplace,
  onRevoke,
}: {
  replaceable: boolean;
  displayName: string;
  onReplace: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<"replace" | "revoke" | null>(null);
  return (
    <>
      <Dropdown.Root>
        <ButtonUtility
          icon={DotsHorizontal}
          size="sm"
          color="tertiary"
          className="shrink-0"
          tooltip={m.external_agent_credential_actions()}
        />
        <Dropdown.Popover placement="bottom end" className="w-max max-w-[calc(100vw-1rem)]">
          <Dropdown.Menu
            aria-label={m.external_agent_credential_actions()}
            onAction={(key) => setConfirming(key === "replace" ? "replace" : "revoke")}
          >
            {replaceable ? (
              <Dropdown.Item
                id="replace"
                icon={RefreshCw01}
                label={m.external_agent_credential_replace()}
              />
            ) : null}
            <Dropdown.Item
              id="revoke"
              icon={Trash01}
              label={m.external_agent_credential_revoke()}
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ConfirmDialog
        open={confirming === "replace"}
        onOpenChange={(open) => setConfirming(open ? "replace" : null)}
        tone="default"
        title={m.external_agent_credential_replace_title()}
        description={m.external_agent_credential_replace_body({ name: displayName })}
        confirmLabel={m.external_agent_credential_replace()}
        errorMessage={externalCredentialErrorMessage}
        onConfirm={onReplace}
      />
      <ConfirmDialog
        open={confirming === "revoke"}
        onOpenChange={(open) => setConfirming(open ? "revoke" : null)}
        title={m.external_agent_credential_revoke_title()}
        description={m.external_agent_credential_revoke_body()}
        confirmLabel={m.external_agent_credential_revoke()}
        errorMessage={m.external_agent_credential_failed()}
        onConfirm={onRevoke}
      />
    </>
  );
}
