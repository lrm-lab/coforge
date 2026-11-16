import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { m } from "#src/paraglide/messages";
import {
  revokeAllExternalAgentCredentials,
  revokeExternalAgentCredential,
} from "#src/features/agents/external-agent-credentials.functions";
import { ExternalAgentCommandBox } from "#src/features/agents/external-agent-form";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

export type ExternalCredentialSummary = {
  id: string;
  machineName: string;
  hostname: string;
  os: string;
  clientName: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
};

export function ExternalAgentAccessSection({
  agentId,
  agentName,
  workspaceSlug,
  credentials,
  canManage,
  timeZone,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  workspaceSlug: string | null;
  credentials: readonly ExternalCredentialSummary[];
  canManage: boolean;
  timeZone: string | null;
  onChanged?: () => Promise<void> | void;
}) {
  const revokeOne = useServerFn(revokeExternalAgentCredential);
  const revokeAll = useServerFn(revokeAllExternalAgentCredentials);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  async function handleRevokeOne(credentialId: string) {
    setBusyId(credentialId);
    try {
      await revokeOne({ data: { agentId, credentialId } });
      await onChanged?.();
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevokeAll() {
    setBusyId("all");
    try {
      await revokeAll({ data: { agentId } });
      await onChanged?.();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="border-b border-secondary px-6 py-5">
      <p className={SECTION_CAPTION_CLASS}>{m.external_agent_access_section()}</p>
      {credentials.length === 0 ? (
        <p className="mt-3 text-sm text-tertiary">{m.external_agent_access_empty()}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {credentials.map((credential) => {
            const label = credential.machineName || credential.hostname || "—";
            return (
              <li
                key={credential.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{label}</p>
                  <p className="mt-0.5 truncate text-xs text-tertiary">
                    {[credential.os, credential.clientName].filter(Boolean).join(" · ") || "—"}
                  </p>
                  <p className="mt-1 text-xs text-tertiary">
                    {credential.lastUsedAt ? (
                      <>
                        {m.external_agent_access_last_used({ time: "" })}
                        <RelativeTime value={credential.lastUsedAt} timeZone={timeZone} />
                      </>
                    ) : (
                      m.external_agent_access_never_used()
                    )}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    type="button"
                    size="sm"
                    color="secondary"
                    className="shrink-0"
                    isDisabled={busyId !== null}
                    isLoading={busyId === credential.id}
                    onPress={() => void handleRevokeOne(credential.id)}
                  >
                    {m.external_agent_access_revoke()}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {workspaceSlug ? (
              <Button
                type="button"
                size="sm"
                color="secondary"
                iconLeading={Plus}
                onPress={() => setShowConnect((open) => !open)}
              >
                {m.external_agent_access_connect_another()}
              </Button>
            ) : null}
            {credentials.length > 0 ? (
              <Button
                type="button"
                size="sm"
                color="secondary-destructive"
                iconLeading={Trash01}
                isDisabled={busyId !== null}
                isLoading={busyId === "all"}
                onPress={() => void handleRevokeAll()}
              >
                {m.external_agent_access_revoke_all()}
              </Button>
            ) : null}
          </div>
          {showConnect && workspaceSlug ? (
            <ExternalAgentCommandBox workspaceSlug={workspaceSlug} agentName={agentName} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
