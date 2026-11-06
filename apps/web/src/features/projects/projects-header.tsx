import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, Plus } from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { EntityPicker, Face, projectOptions } from "#src/features/pickers/entity-picker";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { CreateProjectDialog } from "./create-project-dialog";
import { listProjects } from "./projects.functions";

/** The switcher's row for every Project's Tasks, by a key no Project slug can be. */
const ALL = " all";

type HeaderProject = { slug: string; name: string; iconUrl?: string | null };

/**
 * The Projects page's header, on All tasks and on one Project alike (task #596): "Projects", a
 * switcher between All tasks and each Project, and "Create Project" on the right. A Project adds
 * its own tabs and controls (`tabs`, `meta`).
 */
export function ProjectsHeader({
  project,
  meta,
  actions,
  tabs,
}: {
  /** The Project shown, or none for All tasks. */
  project?: HeaderProject;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const open = (slug: string) =>
    navigate({
      to: "/w/$workspaceSlug/projects/$projectSlug",
      params: { workspaceSlug, projectSlug: slug },
    });
  return (
    <>
      <PageHeader
        heading={m.projects_title()}
        meta={
          <>
            <span aria-hidden="true" className="text-lg text-quaternary">
              /
            </span>
            <ProjectSwitcher
              project={project}
              onPick={(slug) =>
                slug === ALL
                  ? void navigate({ to: "/w/$workspaceSlug/projects", params: { workspaceSlug } })
                  : void open(slug)
              }
            />
            {meta}
          </>
        }
        actions={
          <>
            {actions}
            <Button
              size="sm"
              color="secondary"
              iconLeading={Plus}
              onPress={() => setCreating(true)}
              // On a phone the header holds its icon only.
              className="max-sm:*:data-text:sr-only"
            >
              {m.project_create()}
            </Button>
          </>
        }
        tabs={tabs}
      />
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        // A new Project opens on its own board.
        onCreated={async ({ slug }) => void (await open(slug))}
      />
    </>
  );
}

/** All tasks or one Project, picked from a searchable list of the Workspace's Projects. */
function ProjectSwitcher({
  project,
  onPick,
}: {
  project?: HeaderProject;
  onPick: (slug: string) => void;
}) {
  const load = useServerFn(listProjects);
  const projects = useQuery({
    queryKey: ["projects-list"],
    queryFn: () => load(),
    staleTime: 60_000,
  });
  const list = projects.data ?? [];
  const label = project?.name ?? m.projects_all_tasks();
  return (
    <EntityPicker
      trigger={
        <AriaButton
          aria-label={`${m.projects_switch()}: ${label}`}
          className="group -mx-1.5 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-lg font-semibold text-primary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 pressed:bg-primary_hover"
        >
          {project && <Face face={{ kind: "project", name: project.name, src: project.iconUrl }} />}
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        </AriaButton>
      }
      label={m.projects_switch()}
      searchPlaceholder={m.tasks_project_search()}
      selectedKey={project?.slug ?? ALL}
      options={[
        { id: ALL, label: m.projects_all_tasks() },
        // Keyed by slug, which the address names a Project by.
        ...projectOptions(list).map((option, index) => ({ ...option, id: list[index]!.slug })),
      ]}
      onSelect={(key) => onPick(String(key))}
    />
  );
}
