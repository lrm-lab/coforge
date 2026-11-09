import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { DepartureImpact, useDepartureImpact } from "./departure-impact-view";
import { previewWorkspaceMemberRemoval } from "./members.functions";

/**
 * Confirms removing a member from the Workspace, and says which Computers that disconnects and
 * how many Agents on them go offline. Confirming stays possible when the check failed.
 */
export function MemberRemovalDialog({
  open,
  onOpenChange,
  userId,
  name,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  name: string;
  onConfirm: () => Promise<void>;
}) {
  const preview = useServerFn(previewWorkspaceMemberRemoval);
  const load = useCallback(() => preview({ data: { userId } }), [preview, userId]);
  const { state, retry } = useDepartureImpact({ open, subject: userId, load });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.member_person_remove_confirm_title({ name })}
      description={m.member_person_remove_confirm_description()}
      detail={<DepartureImpact state={state} subject={{ kind: "remove", name }} onRetry={retry} />}
      confirmDisabled={state.kind === "loading"}
      confirmLabel={m.member_person_remove()}
      errorMessage={m.workspace_members_action_failed()}
      onConfirm={onConfirm}
    />
  );
}
