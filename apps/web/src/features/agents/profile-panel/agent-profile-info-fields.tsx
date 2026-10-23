import { useState } from "react";
import { Edit01 } from "@untitledui/icons";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { AGENT_VISIBILITY, type AgentVisibility } from "#src/features/agents/agent-visibility";
import { FactRow } from "./agent-fact-row";

/**
 * Visibility reads as a badge, same as Role; an authorized viewer (creator or Workspace
 * owner/admin) also gets a "Make private"/"Make public" button next to it. Both directions have
 * real consequences, so the button opens the container's confirmation dialog rather than
 * applying immediately.
 */
export function VisibilityField({
  visibility,
  onRequest,
}: {
  visibility: AgentVisibility;
  onRequest?: (target: AgentVisibility) => void;
}) {
  const isPrivate = visibility === AGENT_VISIBILITY.PRIVATE;
  return (
    <FactRow label={m.agent_profile_visibility()}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge color={isPrivate ? "gray" : "brand"} size="sm">
          {isPrivate ? m.agent_visibility_label_private() : m.agent_visibility_label_public()}
        </Badge>
        {onRequest && (
          <Button
            size="sm"
            color="secondary"
            onPress={() =>
              onRequest(isPrivate ? AGENT_VISIBILITY.PUBLIC : AGENT_VISIBILITY.PRIVATE)
            }
          >
            {isPrivate
              ? m.agent_visibility_confirm_public_submit()
              : m.agent_visibility_confirm_private_submit()}
          </Button>
        )}
      </div>
    </FactRow>
  );
}

/** Role reads as a badge; a manager's pencil swaps it for the Select until a choice is made. */
export function RoleField({
  role,
  onSave,
}: {
  role: string;
  onSave?: (role: "admin" | "member") => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <FactRow
      label={
        <>
          {m.agent_profile_role()}
          {onSave && !editing && (
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Edit01}
              aria-label={m.agent_profile_edit_role()}
              tooltip={m.agent_profile_edit_role()}
              onClick={() => setEditing(true)}
            />
          )}
        </>
      }
    >
      <div>
        {editing && onSave ? (
          <Select
            aria-label={m.agent_profile_edit_role()}
            size="sm"
            selectedKey={role === "admin" ? "admin" : "member"}
            onSelectionChange={(key) => {
              setEditing(false);
              void onSave(key === "admin" ? "admin" : "member");
            }}
            className="w-36"
          >
            <Select.Item id="member" label={m.agent_role_member()} />
            <Select.Item id="admin" label={m.agent_role_admin()} />
          </Select>
        ) : (
          <Badge color="gray" size="sm">
            {role === "admin" ? m.agent_role_admin() : m.agent_role_member()}
          </Badge>
        )}
      </div>
    </FactRow>
  );
}
