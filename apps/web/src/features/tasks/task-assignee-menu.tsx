import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { EntityPicker, memberOption } from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import { TaskPerson } from "./task-owner";
import { TaskFieldTrigger as EditableTrigger } from "./task-field-trigger";

const UNASSIGNED = "unassigned";
const memberKey = (member: { kind: string; id: string }) => `${member.kind}:${member.id}`;

export function AssigneeMenu({
  task,
  members,
  disabled,
  onSelect,
}: {
  task: TaskView;
  members?: readonly Mentionable[];
  disabled: boolean;
  /** The picked member bound by id (`user:<id>` or `agent:<id>`), or null for no one. */
  onSelect: (assignee: string | null) => void;
}) {
  const name = task.owner?.name ?? m.tasks_unassigned();
  const value = task.owner ? (
    <TaskPerson person={task.owner} />
  ) : (
    <span className="text-tertiary">{name}</span>
  );
  if (!members) return value;
  const ownerKey = task.owner ? memberKey(task.owner) : UNASSIGNED;
  return (
    <EntityPicker
      trigger={
        <EditableTrigger
          label={`${m.tasks_change_assignee()}: ${name}${task.owner?.deleted ? `, ${m.agent_deleted_badge()}` : ""}`}
          disabled={disabled}
        >
          {value}
        </EditableTrigger>
      }
      label={m.tasks_change_assignee()}
      selectedKey={ownerKey}
      options={[{ id: UNASSIGNED, label: m.tasks_unassigned() }, ...members.map(memberOption)]}
      // By id, never by handle: a person and an Agent may share a name.
      onSelect={(key) => onSelect(key === UNASSIGNED ? null : key)}
    />
  );
}
