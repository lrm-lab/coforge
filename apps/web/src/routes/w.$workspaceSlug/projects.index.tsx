import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsHeader } from "#src/features/projects/projects-header";
import { taskBoardSearchShape } from "#src/features/tasks/task-board-search";
import { taskOverviewQuery } from "#src/features/tasks/task-overview-collection";
import { overviewTaskParamSchema } from "#src/features/tasks/task-overview-search";
import { TasksPending } from "#src/features/tasks/tasks-pending";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import { WorkspaceTaskBoard } from "#src/features/tasks/workspace-task-board";

/**
 * The Projects page opens on All tasks (task #596): the one Task board, across every Project and
 * none, with the Project switcher and "Create Project" above it. `/tasks` comes here with its
 * search kept.
 */
export const Route = createFileRoute("/w/$workspaceSlug/projects/")({
  validateSearch: z.object({
    ...taskBoardSearchShape,
    task: overviewTaskParamSchema,
  }),
  loaderDeps: ({ search }) => ({ completed: search.completed }),
  // The rows go into the Query cache, which the server render reads and the client hydrates;
  // after hydration they back the page's collection (`task-overview-collection.ts`). A navigation
  // reads them afresh; a hover preload reuses what is cached.
  loader: async ({ context: { queryClient }, parentMatchPromise, cause, deps }) => {
    const workspaceId = (await parentMatchPromise).loaderData?.currentWorkspace?.id ?? "";
    const staleTime = cause === "preload" ? "static" : 0;
    await Promise.all([
      // A window change on the page re-runs this loader; the unfinished rows it holds stay live.
      cause === "stay"
        ? undefined
        : queryClient.query({ ...taskOverviewQuery(workspaceId), staleTime }),
      // Done and Closed show their counts at once; their Tasks are read when a group opens.
      queryClient.query({
        ...finishedSummaryQuery({ workspaceId }, deps.completed ?? "week"),
        staleTime,
      }),
    ]);
  },
  pendingComponent: AllTasksPending,
  errorComponent: PageLoadError,
  component: AllTasksPage,
});

function AllTasksPage() {
  return (
    <main className="flex h-full min-w-0 flex-col bg-primary">
      <ProjectsHeader />
      <WorkspaceTaskBoard search={Route.useSearch()} />
    </main>
  );
}

/** The loading page in the layout the address asks for, so it matches what arrives. */
function AllTasksPending() {
  const { layout } = Route.useSearch();
  return <TasksPending layout={layout} />;
}
