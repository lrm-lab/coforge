import { useState } from "react";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { useAppToast } from "#src/components/ui/toast";
import { detachCommand, setupCommand } from "#src/features/install/install-commands";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatCalendarDate } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { reconnectCloudComputer } from "./cloud-computers.functions";
import { computerKind } from "./computer-identity";
import { ComputerTerminalCommand } from "./computer-terminal-command";

export type ComputerConnectRefusal = { reason: DaemonConnectRejectionReason; at: string };

/**
 * The refusal that explains why this Computer is offline, if one does. A Computer that is online
 * connected after it, so the record is on its way out (the next good connect clears it).
 */
export function activeRefusal(computer: {
  online: boolean;
  connectRefusal?: ComputerConnectRefusal | null;
}): ComputerConnectRefusal | null {
  return computer.online ? null : (computer.connectRefusal ?? null);
}

/** The reason in a few words, for a Computer list row. */
export function refusalLabel(reason: DaemonConnectRejectionReason): string {
  switch (reason) {
    case "credential_revoked":
      return m.computer_refusal_label_credential_revoked();
    case "computer_unlinked":
      return m.computer_refusal_label_computer_unlinked();
    case "workspace_deleted":
      return m.computer_refusal_label_workspace_deleted();
  }
}

function refusalTitle(reason: DaemonConnectRejectionReason): string {
  switch (reason) {
    case "credential_revoked":
      return m.computer_refusal_title_credential_revoked();
    case "computer_unlinked":
      return m.computer_refusal_title_computer_unlinked();
    case "workspace_deleted":
      return m.computer_refusal_title_workspace_deleted();
  }
}

/** Why CoForge refuses this Computer and what moves it on, at the top of its page. */
export function ComputerRefusalAlert({
  refusal,
  computer,
  timeZone,
}: {
  refusal: ComputerConnectRefusal;
  computer: { id: string; kind: string; ownedByCurrentUser: boolean };
  timeZone: string | null;
}) {
  const workspaceSlug = useWorkspaceSlug();
  // The viewer's zone is known once the page is hydrated.
  const hydrated = useHydrated();
  // A deleted Workspace cannot be joined again: the command is for another one, named by the owner.
  const deleted = refusal.reason === "workspace_deleted";
  // Setup refuses a stored key the server no longer takes, so a binding is detached first.
  const command = deleted
    ? setupCommand("<workspace-slug>")
    : `${detachCommand(workspaceSlug)}\n${setupCommand(workspaceSlug)}`;
  const cloud = computerKind(computer.kind) === "cloud";
  // Only a revoked credential mends from CoForge; a cloud Computer's other refusals do not.
  const reconnects = cloud && refusal.reason === "credential_revoked";
  const mendable = !deleted && (!cloud || reconnects);
  return (
    <Alert
      color="error"
      title={refusalTitle(refusal.reason)}
      description={
        <div className="flex flex-col gap-3">
          <p>
            {hydrated
              ? m.computer_refusal_stopped({
                  date: formatCalendarDate(refusal.at, timeZone, getLocale()),
                })
              : m.computer_refusal_stopped_undated()}
          </p>
          {!computer.ownedByCurrentUser
            ? mendable && <p>{m.computer_refusal_ask_owner()}</p>
            : // The cloud host re-attaches from CoForge, not from a shell its owner runs.
              !cloud && (
                <div className="flex flex-col gap-2">
                  <p>{deleted ? m.computer_refusal_run_other() : m.computer_refusal_run()}</p>
                  <ComputerTerminalCommand
                    command={command}
                    copyLabel={m.computer_refusal_copy()}
                  />
                </div>
              )}
        </div>
      }
      actions={
        reconnects && computer.ownedByCurrentUser && <RefusalReconnect computerId={computer.id} />
      }
    />
  );
}

/** Queues a fresh attach for the cloud Computer. It takes the host a while, so the button stays
 * spent; the refusal goes when the Computer connects and the page next reads it. */
function RefusalReconnect({ computerId }: { computerId: string }) {
  const reconnect = useServerFn(reconnectCloudComputer);
  const router = useRouter();
  const toast = useAppToast();
  const [state, setState] = useState<"idle" | "pending" | "queued">("idle");
  return (
    <Button
      size="sm"
      color="secondary"
      isDisabled={state !== "idle"}
      isLoading={state === "pending"}
      onPress={async () => {
        setState("pending");
        try {
          await reconnect({ data: { computerId } });
          setState("queued");
          toast.success(m.computer_refusal_reconnect_queued());
          await router.invalidate();
        } catch {
          setState("idle");
          toast.error(m.computer_refusal_reconnect_failed());
        }
      }}
    >
      {state === "queued" ? m.computer_refusal_reconnecting() : m.computer_refusal_reconnect()}
    </Button>
  );
}
