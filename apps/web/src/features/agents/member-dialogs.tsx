import { InviteMemberDialog } from "#src/features/workspaces/invite-member-dialog";
import { NewAgentDialog, type AgentCreateKind } from "./new-agent-dialog";

export type MemberDialog = "create-agent" | "invite";

export function MemberDialogs({
  dialog,
  onDialogChange,
  allowed,
  agentKind,
}: {
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
  allowed: boolean;
  agentKind?: AgentCreateKind;
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
        conversationReplacesPage
        initialKind={agentKind}
      />
    </>
  );
}
