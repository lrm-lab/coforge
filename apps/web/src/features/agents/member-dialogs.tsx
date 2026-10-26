import { InviteMemberDialog } from "#src/features/workspaces/invite-member-dialog";
import { AgentCreateDialog, type AgentCreateComputerOption } from "./agent-create-dialog";
import type { RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";

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
  computers,
  onCreate,
  onLoadRuntimeCatalog,
  onCreated,
}: {
  dialog?: MemberDialog;
  onDialogChange: (dialog: MemberDialog | undefined) => void;
  allowed: boolean;
  computers: AgentCreateComputerOption[];
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  onCreated: (result: { startPublished: boolean }) => void;
}) {
  return (
    <>
      <InviteMemberDialog
        open={allowed && dialog === "invite"}
        onOpenChange={(next) => onDialogChange(next ? "invite" : undefined)}
      />
      <AgentCreateDialog
        open={allowed && dialog === "create-agent"}
        onOpenChange={(next) => onDialogChange(next ? "create-agent" : undefined)}
        computers={computers}
        onCreate={onCreate}
        onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        onCreated={onCreated}
      />
    </>
  );
}
