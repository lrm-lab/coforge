import type { PrismaClient } from "#src/generated/prisma/client";
import { readCommitCoAuthor } from "./github-config.server";

/**
 * Decides the `Co-authored-by` trailer(s) an Agent's commit to `repository` should carry (empty
 * means none). The CLI (`coforge git prepare-commit-msg`) never builds this itself - see
 * `apps/web/src/routes/api/agent/v1/github-commit-trailers.ts`.
 *
 * - No configured co-author (`COFORGE_COMMIT_COAUTHOR` unset or invalid - see
 *   `readCommitCoAuthor`) always answers no trailers, for every repository.
 * - Otherwise a `repository` bound to a Project in this Workspace follows that Project's
 *   `commitCoAuthor` toggle (default on).
 * - Any other repository, or no repository at all (`repository === null`, e.g. no `origin` or a
 *   non-github.com remote), defaults on: there is no Project setting to turn it off.
 */
export async function resolveGitHubCommitTrailers(
  db: PrismaClient,
  workspaceId: string,
  repository: string | null,
  env: Record<string, string | undefined> = Bun.env,
): Promise<string[]> {
  const coAuthor = readCommitCoAuthor(env);
  if (!coAuthor) return [];
  if (repository) {
    const project = await db.project.findFirst({
      where: { workspaceId, githubFullName: { equals: repository, mode: "insensitive" } },
      select: { commitCoAuthor: true },
    });
    if (project && !project.commitCoAuthor) return [];
  }
  return [`Co-authored-by: ${coAuthor}`];
}
