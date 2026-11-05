# Projects UI

These rules apply to `src/features/projects/`.

- AppShell exposes one Projects navigation item on desktop and mobile.
  Project creation belongs on the Projects page, not in either sidebar.
- The file browser loads the repository tree once per visit and keys file
  content by blob oid, which never goes stale. Do not refetch the tree per
  directory or re-read content already cached for an oid.
- Downloads use the authorized `/api/projects/$projectId/raw/$` route; GitHub
  and download URLs are built in `project-file-urls.ts`.
- A Project page has three tabs (task #504): Overview (description, progress, people and its
  Tasks in progress / up next / recently done), Tasks (the Tasks page's board through
  `WorkspaceTaskBoard` with `project`, so no Project is picked or shown) and Code, only with a
  linked repository. A Task opens its popup over the page.
- The Tasks tab's list layout (a phone's default) is the task tree (task #462,
  `project-task-tree.tsx`): React Aria's `Tree`, each Task under its parent, read from
  `loadProjectTasks`; a filter keeps a passing Task's ancestors greyed, and the channel picks are
  offered only there (the board never applies them, even from a typed address). While the tree
  shows, the board's Done and Closed reads are off; the toolbar's picks come from the tree's
  Tasks. A Task of the viewer's own DM opens from it (`overviewTask` reads own DMs too).
