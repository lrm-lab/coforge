import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { EntityPicker, Face, projectOption } from "#src/features/pickers/entity-picker";
import { listProjects } from "#src/features/projects/projects.functions";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";

/** The picker's row for "the channel's Project again", by a key no Project slug can be. */
const FOLLOW = " follow";

/**
 * A Task's Project in its popup (task #460): the one it is filed under, or none, and a picker of
 * the Workspace's Projects, with "the channel's Project" to file it with its conversation again.
 * The Projects are read when the picker first opens.
 */
export function TaskProjectMenu({
  task,
  disabled,
  onSelect,
}: {
  task: Pick<TaskView, "project">;
  disabled: boolean;
  /** A Project by slug, or null to file the Task under its conversation's Project again. */
  onSelect: (project: string | null) => void;
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
  const value = current ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <Face face={{ kind: "project", name: current.name }} />
      <span className="truncate">{current.name}</span>
    </span>
  ) : (
    <span className="text-tertiary">{m.tasks_project_none()}</span>
  );
  return (
    <span onPointerEnter={() => setWanted(true)} onFocus={() => setWanted(true)}>
      <EntityPicker
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
        selectedKey={current?.slug ?? FOLLOW}
        options={[
          { id: FOLLOW, label: m.tasks_project_follow() },
          ...(projects.data ?? []).map((project) => ({
            ...projectOption(project),
            id: project.slug,
          })),
        ]}
        onSelect={(key) => onSelect(key === FOLLOW ? null : key)}
      />
    </span>
  );
}
