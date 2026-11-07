import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Edit01 as Pencil } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import {
  deleteAgentRuntimeCredential,
  saveAgentRuntimeCredential,
} from "#src/features/agents/agents.functions";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { AgentRuntimeCredentialDialog } from "#src/features/agents/agent-runtime-credential-dialog";
import { useInvalidateAgentProfile } from "./agent-profile-queries";

type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

/** The Profile tab's runtime-credential pencil and its dialog: only a `coforge` provider takes
 * an API key, so the section is absent for every other runtime and for a stored config the
 * server could not read (task #517). */
export function AgentRuntimeCredentialSection({
  agentId,
  runtimeConfig,
  runtimeCredential,
}: {
  agentId: string;
  runtimeConfig: AgentProfile["runtimeConfig"];
  runtimeCredential: AgentProfile["runtimeCredential"];
}) {
  const [open, setOpen] = useState(false);
  const [saving, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const invalidate = useInvalidateAgentProfile(agentId);
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  if (!runtimeConfig || runtimeConfig.provider.kind !== "coforge") return null;
  const providerId = runtimeConfig.provider.providerId;
  return (
    <>
      <ButtonUtility
        aria-label={m.agent_runtime_edit()}
        tooltip={m.agent_runtime_edit()}
        icon={Pencil}
        size="xs"
        color="tertiary"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      />
      {open && (
        <AgentRuntimeCredentialDialog
          open={open}
          onOpenChange={setOpen}
          saving={saving}
          runtimeLabel={runtimeProviderLabel(runtimeConfig.runtime)}
          providerId={providerId}
          credentialHint={runtimeCredential?.hint}
          error={error}
          modelFields={[
            {
              label: m.agent_form_model(),
              value: runtimeConfig.model || m.agent_form_provider_default(),
            },
            {
              label: m.agent_form_reasoning(),
              value: runtimeConfig.reasoning || m.agent_form_provider_default(),
            },
          ]}
          onSave={(apiKey) =>
            guard(async () => {
              setError("");
              try {
                await saveCredential({ data: { agentId, apiKey } });
                setOpen(false);
                await invalidate();
              } catch {
                setError(m.agent_runtime_save_error());
              }
            })
          }
          onDelete={
            runtimeCredential
              ? () =>
                  guard(async () => {
                    setError("");
                    try {
                      await deleteCredential({ data: agentId });
                      setOpen(false);
                      await invalidate();
                    } catch {
                      setError(m.agent_runtime_delete_error());
                    }
                  })
              : undefined
          }
        />
      )}
    </>
  );
}
