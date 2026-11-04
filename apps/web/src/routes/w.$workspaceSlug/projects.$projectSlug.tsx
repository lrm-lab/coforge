import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsPending } from "#src/features/projects/projects-pending";
import { ProjectDetail } from "#src/features/projects/project-detail";
import { getProject, getProjectRepository } from "#src/features/projects/projects.functions";
import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { taskOverviewQuery } from "#src/features/tasks/task-overview-collection";
import { overviewTaskParamSchema } from "#src/features/tasks/task-overview-search";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";

export const Route = createFileRoute("/w/$workspaceSlug/projects/$projectSlug")({
  // The tab, the Tasks tab's board view (the Project is fixed, so none is picked) and the Task
  // whose popup is open over the page.
  validateSearch: z.object({
    tab: z.enum(["overview", "tasks", "code"]).optional().catch(undefined),
    ...conversationTaskBoardSearchShape,
    task: overviewTaskParamSchema,
  }),
  loaderDeps: ({ search }) => ({ completed: search.completed }),
  loader: async ({ params, context: { queryClient }, parentMatchPromise, cause, deps }) => {
    const workspaceId = (await parentMatchPromise).loaderData?.currentWorkspace?.id ?? "";
    const staleTime = cause === "preload" ? "static" : 0;
    // The board's rows, as the Tasks page reads them (its loader explains the cache).
    const [project] = await Promise.all([
      getProject({ data: { slug: params.projectSlug } }),
      cause === "stay"
        ? undefined
        : queryClient.query({ ...taskOverviewQuery(workspaceId), staleTime }),
      queryClient.query({
        ...finishedSummaryQuery({ workspaceId }, deps.completed ?? "week"),
        staleTime,
      }),
    ]);
    if (!project) throw notFound();
    return {
      project,
      repository: getProjectRepository({ data: { slug: params.projectSlug } }).catch(() => ({
        status: "unavailable" as const,
      })),
    };
  },
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectPage,
});

function ProjectPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectDetail
      {...Route.useLoaderData()}
      search={search}
      // A tab is a history entry; the Task popup closes with the tab it was opened from.
      onTabChange={(tab) =>
        void navigate({
          search: (previous) => ({
            ...previous,
            tab: tab === "overview" ? undefined : tab,
            task: undefined,
          }),
        })
      }
    />
  );
}
