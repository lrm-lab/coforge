import { Edit01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { AGENT_VISIBILITY, type AgentVisibility } from "#src/features/agents/agent-visibility";
import { FactRow } from "./agent-fact-row";

/**
 * Plain-text value followed by an edit pencil that opens a small menu of the choices, the
 * current one checked. Picking the current one, Escape or a click away just closes the menu;
 * only a different choice reaches `onChoose`. Without `onChoose` only the text shows.
 */
function EditableValue<K extends string>({
  editLabel,
  options,
  selected,
  onChoose,
}: {
  editLabel: string;
  options: readonly { id: K; label: string }[];
  selected: K;
  onChoose?: (key: K) => void;
}) {
  const text = options.find((option) => option.id === selected)?.label;
  return (
    <div className="flex items-center gap-1.5">
      <span>{text}</span>
      {onChoose && (
        <Dropdown.Root>
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={Edit01}
            aria-label={editLabel}
            tooltip={editLabel}
          />
          <Dropdown.Popover placement="bottom start" className="w-36">
            <Dropdown.Menu
              aria-label={editLabel}
              selectionMode="single"
              selectedKeys={[selected]}
              onAction={(key) => {
                const choice = options.find((option) => option.id === key);
                if (choice && choice.id !== selected) onChoose(choice.id);
              }}
            >
              {options.map((option) => (
                <Dropdown.Item key={option.id} id={option.id} label={option.label} />
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
    </div>
  );
}

/**
 * Visibility reads as plain text, like the other INFO rows; an authorized viewer (creator or
 * Workspace owner/admin) also gets a pencil after it with a Public/Private menu. Picking the
 * other value hands it to `onRequest`, which opens the container's confirmation dialog (both
 * directions have real consequences, so nothing applies immediately).
 */
export function VisibilityField({
  visibility,
  onRequest,
}: {
  visibility: AgentVisibility;
  onRequest?: (target: AgentVisibility) => void;
}) {
  return (
    <FactRow label={m.agent_profile_visibility()}>
      <EditableValue
        editLabel={m.agent_profile_edit_visibility()}
        options={[
          { id: AGENT_VISIBILITY.PUBLIC, label: m.agent_visibility_label_public() },
          { id: AGENT_VISIBILITY.PRIVATE, label: m.agent_visibility_label_private() },
        ]}
        selected={visibility}
        onChoose={onRequest}
      />
    </FactRow>
  );
}

/** Role reads as plain text; a manager's pencil after it opens the Member/Admin menu. */
export function RoleField({
  role,
  onSave,
}: {
  role: string;
  onSave?: (role: "admin" | "member") => Promise<void>;
}) {
  return (
    <FactRow label={m.agent_profile_role()}>
      <EditableValue<"admin" | "member">
        editLabel={m.agent_profile_edit_role()}
        options={[
          { id: "member", label: m.agent_role_member() },
          { id: "admin", label: m.agent_role_admin() },
        ]}
        selected={role === "admin" ? "admin" : "member"}
        onChoose={onSave && ((key) => void onSave(key))}
      />
    </FactRow>
  );
}
