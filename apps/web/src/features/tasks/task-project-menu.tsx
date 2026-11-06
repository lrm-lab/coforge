import type { Placement } from "react-aria-components";
import type { TaskProjectRef, TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { EntityPicker, Face, projectOption } from "#src/features/pickers/entity-picker";
import { listProjects } from "#src/features/projects/projects.functions";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";

/** The picker's row for "no Project", by a key no Project slug can be. */
const NONE = " none";

/**
 * A Task's Project in its popup: the one it is filed under, or none, and a picker of the
 * Workspace's Projects with "None" to clear it. The Projects are read when the picker first opens.
 */
export function TaskProjectMenu({
  task,
  disabled,
  placement,
  lastUsed,
  onSelect,
}: {
  task: Pick<TaskView, "project">;
  disabled: boolean;
  placement?: Placement;
  /** In a form making a Task: the Project the viewer last filed one under, offered first. */
  lastUsed?: TaskProjectRef | null;
  /** A Project, or null to file the Task under no Project. */
  onSelect: (project: TaskProjectRef | null) => void;
}) {
  const [wanted, setWanted] = useState(false);
  const load = useServerFn(listProjects);
  const projects = useQuery({
    queryKey: ["projects-list"],
    queryFn: () => load(),
    enabled: wanted,
    staleTime: 60_000,
  });
  const current = task.project ?? null;
  const rest = (projects.data ?? []).filter((project) => project.slug !== lastUsed?.slug);
  const value = current ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <Face face={{ kind: "project", name: current.name }} />
      <span className="truncate">{current.name}</span>
    </span>
  ) : (
    <span className="text-tertiary">{m.tasks_project_none()}</span>
  );
  return (
    // A flex item, so a long name truncates inside the property rather than widening it (task #588).
    <span
      className="flex min-w-0"
      onPointerEnter={() => setWanted(true)}
      onFocus={() => setWanted(true)}
    >
      <EntityPicker
        placement={placement}
        trigger={
          <TaskFieldTrigger
            label={`${m.tasks_project_change()}: ${current?.name ?? m.tasks_project_none()}`}
            disabled={disabled}
          >
            {value}
          </TaskFieldTrigger>
        }
        label={m.tasks_project_change()}
        searchPlaceholder={m.tasks_project_search()}
        selectedKey={current?.slug ?? NONE}
        options={[
          ...(lastUsed
            ? [
                {
                  ...projectOption(lastUsed),
                  id: lastUsed.slug,
                  note: m.tasks_project_last_used(),
                },
              ]
            : []),
          { id: NONE, label: m.tasks_project_none() },
          ...rest.map((project) => ({
            ...projectOption(project),
            id: project.slug,
          })),
        ]}
        onSelect={(key) => {
          if (key === NONE) return onSelect(null);
          if (key === lastUsed?.slug) return onSelect(lastUsed);
          const project = projects.data?.find((each) => each.slug === key);
          if (project) onSelect({ id: project.id, name: project.name, slug: project.slug });
        }}
      />
    </span>
  );
}
