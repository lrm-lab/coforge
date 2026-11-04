import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Folder } from "@untitledui/icons";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { projectDirectoryCommitsQuery } from "./project-tree-queries";
import { isBrowsable, type TreeEntry } from "./tree-index";
import { githubUrl as buildGithubUrl } from "./project-file-urls";

type LastCommit = { sha: string; message: string; date: string } | null;

/** A directory of a Project's repository: its latest commit and its entries, each with the
 * commit that last touched it. */
export function DirectoryBody({
  slug,
  path,
  entries,
  fullName,
  defaultBranch,
  treeSha,
}: {
  slug: string;
  path: string;
  entries: ReadonlyArray<Pick<TreeEntry, "name" | "path" | "type">>;
  fullName: string;
  defaultBranch: string;
  treeSha: string;
}) {
  const workspaceSlug = useWorkspaceSlug();
  // The listing renders from the tree at once; last commits fill in when their request lands.
  const { data: history } = useQuery(projectDirectoryCommitsQuery(slug, path, treeSha));
  const commits: Record<string, LastCommit> = history?.status === "ready" ? history.commits : {};
  const latest = history?.status === "ready" ? history.latest : null;
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  // Proportional columns, as GitHub's listing has them: a name keeps its full width until it
  // would actually collide with the commit message, instead of truncating at a fixed width.
  const rowClassName =
    "grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_4.5rem] items-center gap-3 px-4 py-2.5 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 sm:grid-cols-[1.25rem_minmax(0,2fr)_minmax(0,3fr)_4.5rem]";
  return (
    <div className="overflow-hidden rounded-xl border border-secondary">
      {/* Held open while loading so the rows below do not jump when the commit arrives. */}
      {(!history || latest) && (
        <div
          aria-busy={!history}
          className="flex h-12 min-w-0 items-center gap-3 border-b border-secondary bg-secondary px-4"
        >
          {latest ? (
            <>
              <span className="flex shrink-0 -space-x-1.5">
                {latest.people.slice(0, 3).map((person) => (
                  <IdentityAvatar
                    key={person.name}
                    size="xs"
                    name={person.name}
                    src={person.avatarUrl}
                    className="ring-2 ring-bg-secondary"
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                <span className="font-medium text-primary">
                  {latest.people.map((person) => person.name).join(", ")}
                </span>{" "}
                {latest.message}
              </span>
              <a
                href={`https://github.com/${fullName}/commit/${latest.sha}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded font-mono text-xs text-tertiary outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2"
              >
                {latest.sha.slice(0, 7)}
              </a>
              {latest.date && (
                <RelativeTime
                  value={latest.date}
                  plain
                  className="shrink-0 text-xs text-tertiary"
                />
              )}
            </>
          ) : (
            <span className="h-2.5 w-64 max-w-full animate-pulse rounded bg-tertiary motion-reduce:animate-none" />
          )}
        </div>
      )}
      <ul className="divide-y divide-secondary">
        {path !== "" && (
          <li>
            <Link
              to="/w/$workspaceSlug/projects/$projectSlug/tree/$"
              params={{ workspaceSlug, projectSlug: slug, _splat: parentPath }}
              className={cn(rowClassName, "text-tertiary")}
            >
              <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
              <span className="col-span-2 text-sm sm:col-span-3">{m.project_tree_parent()}</span>
            </Link>
          </li>
        )}
        {entries.length === 0 ? (
          <li className="px-4 py-16 text-center text-sm text-tertiary">{m.project_tree_empty()}</li>
        ) : (
          entries.map((entry) => {
            const lastCommit = commits[entry.path] ?? null;
            const content = (
              <>
                {entry.type === "dir" ? (
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                ) : (
                  <FileTypeIcon fileName={entry.name} className="size-5" />
                )}
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-sm text-primary",
                      entry.type === "dir" && "font-medium",
                    )}
                  >
                    {entry.name}
                  </span>
                  {!isBrowsable(entry.type) && (
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-quaternary"
                    />
                  )}
                </span>
                {lastCommit ? (
                  <a
                    href={`https://github.com/${fullName}/commit/${lastCommit.sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hidden min-w-0 truncate text-xs text-tertiary outline-focus-ring hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 sm:block"
                  >
                    {lastCommit.message.split("\n")[0]}
                  </a>
                ) : (
                  <span className="hidden min-w-0 sm:block" />
                )}
                <span className="text-right text-xs text-tertiary">
                  {lastCommit?.date && <RelativeTime value={lastCommit.date} plain />}
                </span>
              </>
            );
            return (
              <li key={entry.path}>
                {isBrowsable(entry.type) ? (
                  <Link
                    to="/w/$workspaceSlug/projects/$projectSlug/tree/$"
                    params={{ workspaceSlug, projectSlug: slug, _splat: entry.path }}
                    className={rowClassName}
                  >
                    {content}
                  </Link>
                ) : (
                  <a
                    // Reached only for "symlink"/"submodule" — neither is "dir", so this is always a blob URL.
                    href={buildGithubUrl(fullName, defaultBranch, entry.path, "blob")}
                    target="_blank"
                    rel="noreferrer"
                    className={rowClassName}
                  >
                    {content}
                  </a>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
