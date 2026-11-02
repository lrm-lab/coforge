import { useServerFn } from "@tanstack/react-start";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { humanLabel } from "#src/lib/human-label";
import { AgentVisibilityConfirmDialog } from "#src/features/agents/agent-visibility-confirm-dialog";
import { AgentDeleteDialog } from "#src/features/agents/agent-delete-dialog";
import {
  changeAgentVisibility,
  deleteAgent,
  previewAgentVisibilityChange,
  type getAgentProfile,
} from "#src/features/agents/agents.functions";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";

type Profile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

export function AgentProfileConfirmationDialogs({
  profile,
  agentId,
  visibilityTarget,
  setVisibilityTarget,
  deleteDialogOpen,
  setDeleteDialogOpen,
  onClose,
  invalidate,
}: {
  profile: Profile;
  agentId: string;
  visibilityTarget: AgentVisibility | null;
  setVisibilityTarget: (target: AgentVisibility | null) => void;
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (open: boolean) => void;
  onClose: () => void;
  invalidate: () => Promise<void>;
}) {
  const toast = useAppToast();
  const changeVisibility = useServerFn(changeAgentVisibility);
  const loadVisibilityPreview = useServerFn(previewAgentVisibilityChange);
  const removeAgent = useServerFn(deleteAgent);

  return (
    <>
      {visibilityTarget && (
        <AgentVisibilityConfirmDialog
          agentName={profile.displayName || profile.name}
          creatorName={humanLabel(profile.owner)}
          viewerIsCreator={profile.ownedByCurrentUser}
          target={visibilityTarget}
          open={visibilityTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setVisibilityTarget(null);
          }}
          onLoadPreview={() => loadVisibilityPreview({ data: agentId })}
          onConfirm={async () => {
            await changeVisibility({ data: { agentId, visibility: visibilityTarget } });
            setVisibilityTarget(null);
            await invalidate();
            const displayName = profile.displayName || profile.name;
            toast.success(
              visibilityTarget === "private"
                ? m.agent_visibility_changed_private_toast({ name: displayName })
                : m.agent_visibility_changed_public_toast({ name: displayName }),
            );
          }}
        />
      )}
      <AgentDeleteDialog
        agentName={profile.name}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onDelete={async (confirmation) => {
          await removeAgent({ data: { agentId, confirmation } });
          setDeleteDialogOpen(false);
          onClose();
          await invalidate();
        }}
      />
    </>
  );
}
