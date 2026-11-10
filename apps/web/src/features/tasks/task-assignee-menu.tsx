import type { Placement } from "react-aria-components";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { EntityPicker, memberOption } from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import { TaskPerson } from "./task-owner";
import { TaskFieldTrigger as EditableTrigger } from "./task-field-trigger";
import { User01 } from "@untitledui/icons";
import { UnsetValue } from "./task-property";

const UNASSIGNED = "unassigned";
const memberKey = (member: { kind: string; id: string }) => `${member.kind}:${member.id}`;

export function AssigneeMenu({
  task,
  members,
  disabled,
  placement,
  onSelect,
}: {
  task: Pick<TaskView, "owner"> & { status?: TaskView["status"] };
  members?: readonly Mentionable[];
  disabled: boolean;
  placement?: Placement;
  /** The picked member bound by id (`user:<id>` or `agent:<id>`), or null for no one. */
  onSelect: (assignee: string | null) => void;
}) {
  const name = task.owner?.name ?? m.tasks_unassigned();
  const value = task.owner ? (
    <TaskPerson person={task.owner} wrap />
  ) : (
    <UnsetValue icon={User01} text={name} field={m.tasks_overview_owner()} />
  );
  if (!members) return value;
  const ownerKey = task.owner ? memberKey(task.owner) : UNASSIGNED;
  // A finished Task keeps its owner: the server refuses to leave it with no one, so the option
  // would only fail. Change its status first.
  const unassignable = task.status !== "done";
  return (
    <EntityPicker
      placement={placement}
      trigger={
        <EditableTrigger
          label={`${m.tasks_change_assignee()}: ${name}${task.owner?.deleted ? `, ${m.agent_deleted_badge()}` : ""}`}
          disabled={disabled}
        >
          {value}
        </EditableTrigger>
      }
      label={m.tasks_change_assignee()}
      searchPlaceholder={m.picker_find_member()}
      selectedKey={ownerKey}
      options={[
        ...(unassignable ? [{ id: UNASSIGNED, label: m.tasks_unassigned() }] : []),
        ...members.map(memberOption),
      ]}
      // By id, never by handle: a person and an Agent may share a name.
      onSelect={(key) => onSelect(key === UNASSIGNED ? null : key)}
    />
  );
}
