import { InviteMemberDialog } from "#src/features/workspaces/invite-member-dialog";
import { NewAgentDialog } from "./new-agent-dialog";

/** The Members page dialogs the URL can open; the setup checklist links to `?setup=create-agent`. */
export type MemberDialog = "create-agent" | "invite";

/**
 * Creating an Agent and inviting people, open while the URL names them. A button or a close writes
 * the URL back through `onDialogChange`; a viewer whose role can do neither (`allowed`, owner/admin)
 * sees both stay closed.
 */
export function MemberDialogs({
  dialog,
  onDialogChange,
  allowed,
}: {
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
  allowed: boolean;
}) {
  return (
    <>
      <InviteMemberDialog
        open={allowed && dialog === "invite"}
        onOpenChange={(next) => onDialogChange(next ? "invite" : undefined)}
      />
      <NewAgentDialog
        open={allowed && dialog === "create-agent"}
        onOpenChange={(next) => onDialogChange(next ? "create-agent" : undefined)}
      />
    </>
  );
}
