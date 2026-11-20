import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { useInvalidateAgentProfile } from "./agent-profile-queries";
import { SwitchHorizontal01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import {
  agentMigrationErrorMessage,
  isAgentMigrationInProgress,
  isAgentMigrationShown,
} from "#src/features/agents/agent-migration";
import {
  AgentMigrationStatus,
  AgentMigrationCancelBody,
  AgentPlacementResult,
  useAgentMigrationStatus,
} from "./agent-migration-status";
import { cancelAgentMigration } from "#src/features/agents/agent-migrations.functions";
export function AgentMigrationSection({
  agentId,
  canMove,
  agentOnline,
  onMove,
}: {
  agentId: string;
  canMove: boolean;
  agentOnline: boolean;
  onMove: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidateProfile = useInvalidateAgentProfile(agentId);
  const cancelMove = useServerFn(cancelAgentMigration);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [canceling, guardCancel] = useSubmitGuard();

  const statusKey = ["agent-migration", agentId] as const;
  const status = useAgentMigrationStatus(agentId);
  const latest = status.data?.migration;
  const migration = latest && isAgentMigrationShown(latest) ? latest : undefined;
  const inProgress = migration ? isAgentMigrationInProgress(migration.state) : false;
  const wasInProgress = useRef(inProgress);
  useEffect(() => {
    if (wasInProgress.current && !inProgress) void invalidateProfile();
    wasInProgress.current = inProgress;
  }, [inProgress, invalidateProfile]);

  if (!status.data || (!status.data.available && !migration)) {
    return <AgentPlacementResult agentId={agentId} agentOnline={agentOnline} />;
  }
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), invalidateProfile()]);

  function cancel() {
    if (!migration || canceling) return;
    setCancelError("");
    void guardCancel(async () => {
      try {
        await cancelMove({ data: { agentId, migrationId: migration.id } });
        setConfirmCancel(false);
        await refresh();
      } catch (cause) {
        setCancelError(agentMigrationErrorMessage(cause));
        await refresh().catch(() => undefined);
      }
    });
  }

  return (
    <>
      <AgentPlacementResult agentId={agentId} agentOnline={agentOnline} />
      {migration && (
        <AgentMigrationStatus
          migration={migration}
          targetName={migration.targetComputerName || m.agent_computer_unnamed()}
          sourceName={migration.sourceComputerName || m.agent_computer_unnamed()}
          onCancel={
            canMove
              ? () => {
                  setCancelError("");
                  setConfirmCancel(true);
                }
              : undefined
          }
          canceling={canceling}
        />
      )}
      {!status.data.directPlacement && canMove && status.data.available && !inProgress && (
        <Button
          color="secondary"
          className="w-full justify-center"
          iconLeading={SwitchHorizontal01}
          onPress={onMove}
        >
          {migration?.state === "failed" || migration?.state === "canceled"
            ? m.agent_migration_retry()
            : m.agent_migration_action()}
        </Button>
      )}
      <ModalOverlay
        confirmation
        isOpen={confirmCancel}
        onOpenChange={(next: boolean) => {
          if (canceling) return;
          setConfirmCancel(next);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="text-left">
            {({ close }) => (
              <>
                <DialogHeader
                  title={m.agent_migration_cancel_title()}
                  onClose={canceling ? undefined : close}
                />
                <AgentMigrationCancelBody switched={migration?.state === "switched"} />
                {cancelError && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {cancelError}
                  </p>
                )}
                <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                  <DialogCancel isDisabled={canceling} onPress={close}>
                    {m.agent_migration_cancel_keep()}
                  </DialogCancel>
                  <DialogAction
                    autoFocus
                    isDisabled={canceling}
                    isLoading={canceling}
                    showTextWhileLoading
                    onPress={cancel}
                  >
                    {m.agent_migration_cancel_confirm()}
                  </DialogAction>
                </DialogActions>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
