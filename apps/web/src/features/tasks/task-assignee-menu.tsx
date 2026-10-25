import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useState } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";
import { SearchLg } from "@untitledui/icons";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { m } from "#src/paraglide/messages";
import { TaskPerson } from "./task-owner";
import { assigneeFace } from "./assignee-face";
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
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const name = task.owner?.name ?? m.tasks_unassigned();
  const value = task.owner ? (
    <TaskPerson person={task.owner} />
  ) : (
    <span className="text-tertiary">{name}</span>
  );
  if (!members) return value;
  const ownerKey = task.owner ? memberKey(task.owner) : undefined;
  return (
    <Dropdown.Root onOpenChange={(isOpen) => isOpen && setSearch("")}>
      <EditableTrigger
        label={`${m.tasks_change_assignee()}: ${name}${task.owner?.deleted ? `, ${m.agent_deleted_badge()}` : ""}`}
        disabled={disabled}
      >
        {value}
      </EditableTrigger>
      <Dropdown.Popover placement="bottom start" className="w-72">
        <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
          <div className="border-b border-secondary py-1">
            <AriaSearchField
              aria-label={m.tasks_search_members()}
              value={search}
              onChange={setSearch}
              autoFocus
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                <AriaInput
                  placeholder={m.tasks_search_members()}
                  className="w-full bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
                />
              </div>
            </AriaSearchField>
          </div>
          <Dropdown.Menu
            aria-label={m.tasks_change_assignee()}
            selectionMode="single"
            selectedKeys={[ownerKey ?? UNASSIGNED]}
            className="max-h-72"
            onAction={(key) => {
              if (key === UNASSIGNED) {
                if (task.owner) onSelect(null);
                return;
              }
              const member = members.find((candidate) => memberKey(candidate) === key);
              // By id, never by handle: a person and an Agent may share a name.
              if (member && key !== ownerKey) onSelect(memberKey(member));
            }}
          >
            <Dropdown.Item id={UNASSIGNED} label={m.tasks_unassigned()} />
            {members.map((member) => (
              <Dropdown.Item
                key={memberKey(member)}
                id={memberKey(member)}
                textValue={
                  member.kind === "agent" ? `${member.label} ${member.handle}` : member.label
                }
                label={member.label}
                icon={member.avatarUrl ? assigneeFace(member.avatarUrl) : undefined}
                // An Agent is told from a person by its `@handle`; a person is only their name.
                addon={member.kind === "agent" ? `@${member.handle}` : undefined}
              />
            ))}
          </Dropdown.Menu>
        </AriaAutocomplete>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
