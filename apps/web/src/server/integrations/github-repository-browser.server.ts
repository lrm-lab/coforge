import { AppError, isAppErrorCode } from "#src/lib/app-error";
import type { GitHubApi } from "./github-api.server";
import {
  MAX_BLOB_PREVIEW_BYTES,
  MAX_LAST_COMMIT_PATHS,
  MAX_PATHS_PER_QUERY,
  PATH_LATEST_COMMIT_QUERY,
  REPOSITORY_OBJECT_QUERY,
  REPOSITORY_OVERVIEW_QUERY,
  assertGraphQLOk,
  buildPathHistoryQuery,
  encodeRepositoryPath,
  graphqlPathLatestCommitSchema,
  mapChecksState,
  mapEntries,
  pathHistoryQuerySchema,
  repositoryMetadataSchema,
  repositoryObjectQuerySchema,
  repositoryOverviewQuerySchema,
  repositorySelectionSchema,
  restTreeSchema,
  validateRepositoryPath,
  type RepositorySelection,
} from "./github-repository-shapes.server";

// Recursive trees revalidated with `If-None-Match` on every read. GitHub derives an ETag from
// the access token as well as the content (github/docs#34689), so an entry only ever
// revalidates for the User it was stored for — hence the key — and a 304 proves that User may
// still read the repository. Bounded by total entries, not tree count: one tree can be 100,000.
// Module-level: configuredGitHub() builds a new GitHubConnection per request, so an
// instance field would never cache anything.
const MAX_CACHED_TREE_ENTRIES = 300_000;
type RepositoryTree = {
  sha: string;
  truncated: boolean;
  entries: Array<{ path: string; type: "file" | "dir" | "symlink" | "submodule"; sha: string }>;
};
const repositoryTrees = new Map<
  string,
  { etag: string; defaultBranch: string; tree: RepositoryTree }
>();

function rememberRepositoryTree(
  key: string,
  value: { etag: string; defaultBranch: string; tree: RepositoryTree },
) {
  repositoryTrees.delete(key);
  repositoryTrees.set(key, value);
  let total = 0;
  for (const cached of repositoryTrees.values()) total += cached.tree.entries.length;
  // Oldest first; the entry just stored goes last and is dropped only if it alone is too big.
  for (const [oldest, cached] of repositoryTrees) {
    if (total <= MAX_CACHED_TREE_ENTRIES) break;
    repositoryTrees.delete(oldest);
    total -= cached.tree.entries.length;
  }
}

/** What the browser needs from `GitHubConnection`: tokens are read and refreshed only there. */
export type RepositoryAccess = {
  withToken<T>(
    userId: string,
    action: (token: string) => Promise<T>,
  ): Promise<{ ok: true; data: T } | { ok: false }>;
  accessibleRepositories(
    userId: string,
  ): Promise<Array<{ id: number; installationId: number; fullName: string }>>;
};

/** Reads of one selected repository with the user's GitHub token. */
export class GitHubRepositoryBrowser {
  constructor(
    private readonly github: GitHubApi,
    private readonly access: RepositoryAccess,
  ) {}

  async repositoryOverview(userId: string, repository: RepositorySelection) {
    return this.withVerifiedRepository(
      userId,
      repository,
      async (token, { owner, name, defaultBranch }) => {
        const overview = assertGraphQLOk(
          repositoryOverviewQuerySchema.parse(
            await this.github.graphql(
              REPOSITORY_OVERVIEW_QUERY,
              { owner, name, expression: `${defaultBranch}:` },
              token,
            ),
          ),
        );
        const branchRef = overview.data?.repository?.defaultBranchRef;
        if (!branchRef) return { defaultBranch, commits: [], files: [] };

        const commits = (branchRef.target?.history?.nodes ?? []).map((node) => {
          const authorLogin = node.author?.user?.login;
          const author = authorLogin ?? node.author?.name ?? "Unknown";
          const committerLogin = node.committer?.user?.login;
          const committerDisplay = committerLogin ?? node.committer?.name ?? null;
          // `Co-authored-by` trailer identities; the git author (always first) and an
          // already-shown committer are not repeated.
          const coAuthors = node.authors.nodes
            .map((actor) => ({
              name: actor.user?.login ?? actor.name ?? "Unknown",
              email: actor.email ?? null,
              avatarUrl: actor.avatarUrl ?? null,
            }))
            .filter((actor) => actor.name !== author && actor.name !== committerDisplay);
          return {
            sha: node.oid,
            message: node.messageHeadline,
            author,
            authorEmail: node.author?.email ?? null,
            authorAvatarUrl: node.author?.avatarUrl ?? null,
            coAuthors,
            committer: committerDisplay && committerDisplay !== author ? committerDisplay : null,
            committerEmail:
              committerDisplay && committerDisplay !== author
                ? (node.committer?.email ?? null)
                : null,
            date: node.committedDate ?? null,
            verified: node.signature?.isValid ?? false,
            checks: mapChecksState(node.statusCheckRollup?.state),
          };
        });

        const entries = mapEntries(overview.data?.repository?.object?.entries ?? []);
        const withCommits = entries.slice(0, MAX_LAST_COMMIT_PATHS);
        const withoutCommits = entries.slice(MAX_LAST_COMMIT_PATHS);
        const lastCommits = await this.lastCommitsForPaths(
          owner,
          name,
          withCommits.map((entry) => entry.path),
          token,
        );
        const files = [
          ...withCommits.map((entry, index) => ({
            ...entry,
            lastCommit: lastCommits[index] ?? null,
          })),
          ...withoutCommits.map((entry) => ({ ...entry, lastCommit: null })),
        ];

        return { defaultBranch, commits, files };
      },
    );
  }

  /**
   * The whole default-branch tree in one REST request (`recursive=1`), revalidated with
   * `If-None-Match` so an unchanged branch costs a 304 that GitHub does not count against
   * the rate limit. `truncated` is GitHub's own flag (over 100,000 entries or 7 MB); the
   * caller then falls back to `repositoryObject()` per directory.
   */
  async repositoryTree(userId: string, repository: RepositorySelection) {
    return this.withRepository(userId, repository, async (token, selected) => {
      const { defaultBranch } = await this.verifiedMetadata(token, selected);
      const cacheKey = `${selected.repositoryId}:${userId}`;
      const cached = repositoryTrees.get(cacheKey);
      const reusable = cached?.defaultBranch === defaultBranch ? cached : undefined;
      const response = await this.github.send(
        `https://api.github.com/repos/${selected.fullName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
        {
          headers: {
            ...this.github.restHeaders(token),
            ...(reusable ? { "if-none-match": reusable.etag } : {}),
          },
        },
        { alsoAccept: reusable ? [304] : [] },
      );
      if (response.status === 304 && reusable) return { defaultBranch, ...reusable.tree };
      const parsed = restTreeSchema.parse(await response.json());
      const tree: RepositoryTree = {
        sha: parsed.sha,
        truncated: parsed.truncated,
        entries: parsed.tree.map((entry) => ({
          path: entry.path,
          type:
            entry.type === "tree"
              ? "dir"
              : entry.type === "commit"
                ? "submodule"
                : entry.mode === "120000"
                  ? "symlink"
                  : "file",
          sha: entry.sha,
        })),
      };
      const etag = response.headers.get("etag");
      if (etag) rememberRepositoryTree(cacheKey, { etag, defaultBranch, tree });
      return { defaultBranch, ...tree };
    });
  }

  /**
   * One Tree or Blob in a single GraphQL request. `oid` (from `repositoryTree()`) addresses
   * immutable content; without it the path resolves against `HEAD`. The response's
   * `databaseId` is the identity check, so a renamed-and-replaced repository is refused
   * without a second call. Access is GitHub's: a user access token only reaches what both
   * the User and the App installation can read.
   */
  async repositoryObject(
    userId: string,
    repository: RepositorySelection,
    target: { path: string; oid?: string },
  ) {
    const validPath = validateRepositoryPath(target.path);
    return this.withRepository(userId, repository, async (token, selected) => {
      const [owner, name] = selected.fullName.split("/");
      const response = assertGraphQLOk(
        repositoryObjectQuerySchema.parse(
          await this.github.graphql(
            REPOSITORY_OBJECT_QUERY,
            target.oid
              ? { owner, name, oid: target.oid, expression: null }
              : { owner, name, oid: null, expression: `HEAD:${validPath}` },
            token,
          ),
        ),
      );
      const repo = response.data?.repository;
      if (repo && repo.databaseId !== selected.repositoryId) throw new AppError("ACCESS_DENIED");
      const object = repo?.object;
      if (!object) throw new AppError("NOT_FOUND");
      if (object.entries !== undefined)
        return { kind: "tree" as const, path: validPath, entries: mapEntries(object.entries) };
      if (object.byteSize === undefined) throw new AppError("NOT_FOUND");
      const reason: "binary" | "truncated" | "too_large" | undefined = object.isBinary
        ? "binary"
        : object.isTruncated
          ? "truncated"
          : object.byteSize > MAX_BLOB_PREVIEW_BYTES
            ? "too_large"
            : undefined;
      return {
        kind: "blob" as const,
        path: validPath,
        name: validPath.split("/").pop() || validPath,
        oid: object.oid ?? null,
        byteSize: object.byteSize,
        text: reason ? null : (object.text ?? null),
        ...(reason ? { reason } : {}),
      };
    });
  }

  /**
   * What a directory listing shows beyond names: the newest commit touching the directory
   * itself (`latest`, the listing's header) and the last commit per entry, keyed by entry path.
   * Loaded after the listing is already on screen, so these requests never delay navigation.
   */
  async repositoryDirectoryCommits(userId: string, repository: RepositorySelection, path: string) {
    const directory = await this.repositoryObject(userId, repository, { path });
    if (directory.kind !== "tree") throw new AppError("NOT_FOUND");
    const paths = directory.entries.slice(0, MAX_LAST_COMMIT_PATHS).map((entry) => entry.path);
    return this.withRepository(userId, repository, async (token, selected) => {
      const [owner, name] = selected.fullName.split("/");
      const [latest, commits] = await Promise.all([
        this.latestCommitForPath(owner, name, directory.path, selected.repositoryId, token),
        this.lastCommitsForPaths(owner, name, paths, token),
      ]);
      return {
        latest,
        commits: Object.fromEntries(paths.map((entryPath, index) => [entryPath, commits[index]])),
      };
    });
  }

  private async latestCommitForPath(
    owner: string,
    name: string,
    path: string,
    repositoryId: number,
    token: string,
  ) {
    const response = assertGraphQLOk(
      graphqlPathLatestCommitSchema.parse(
        await this.github.graphql(
          PATH_LATEST_COMMIT_QUERY,
          { owner, name, path: path || null },
          token,
        ),
      ),
    );
    const repo = response.data?.repository;
    if (repo && repo.databaseId !== repositoryId) throw new AppError("ACCESS_DENIED");
    const node = repo?.defaultBranchRef?.target?.history?.nodes.at(0);
    if (!node) return null;
    // As GitHub lists them: the author and co-authors, then the committer when it is someone
    // else (e.g. `web-flow` for commits made on github.com); nobody is shown twice.
    const people = [...node.authors.nodes, node.committer]
      .filter((person) => person !== null)
      .map((person) => ({
        name: person.user?.login ?? person.name ?? "Unknown",
        avatarUrl: person.avatarUrl,
      }));
    return {
      sha: node.oid,
      message: node.messageHeadline,
      date: node.committedDate,
      people: people.filter(
        (person, index) => people.findIndex((other) => other.name === person.name) === index,
      ),
    };
  }

  /** The file's bytes, streamed for Download/Raw. Up to GitHub's 100 MB contents limit. */
  async repositoryRaw(userId: string, repository: RepositorySelection, path: string) {
    const validPath = validateRepositoryPath(path);
    if (validPath === "") throw new AppError("NOT_FOUND");
    return this.withRepository(userId, repository, async (token, selected) => {
      await this.verifiedMetadata(token, selected);
      try {
        return await this.github.send(
          `https://api.github.com/repos/${selected.fullName}/contents/${encodeRepositoryPath(validPath)}`,
          {
            headers: {
              ...this.github.restHeaders(token),
              accept: "application/vnd.github.raw+json",
            },
          },
          // The signal also bounds reading the body, and a download streams well past 8 s.
          { timeoutMs: 120_000 },
        );
      } catch (error) {
        // The repository itself was just read with this token, so a 404 here is the path.
        if (isAppErrorCode(error, "ACCESS_DENIED")) throw new AppError("NOT_FOUND");
        throw error;
      }
    });
  }

  /** The REST half of the identity check: the full name still names the selected repository. */
  private async verifiedMetadata(token: string, selected: RepositorySelection) {
    const metadata = repositoryMetadataSchema.parse(
      await this.github.api(`/repos/${selected.fullName}`, token),
    );
    if (metadata.id !== selected.repositoryId || metadata.full_name !== selected.fullName)
      throw new AppError("ACCESS_DENIED");
    return { defaultBranch: metadata.default_branch };
  }

  /**
   * Hot read path for browsing: a current user token and nothing else. Unlike
   * `withVerifiedRepository()` it does not enumerate the User's installations — GitHub
   * already limits a user access token to repositories both the User and the App
   * installation can read — so each caller checks repository identity in its own request.
   */
  private async withRepository<T>(
    userId: string,
    repository: RepositorySelection,
    action: (token: string, selected: RepositorySelection) => Promise<T>,
  ): Promise<T> {
    const selected = repositorySelectionSchema.parse(repository);
    const result = await this.access.withToken(userId, (token) => action(token, selected));
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /**
   * Access check + REST metadata identity check used by `repositoryOverview()`: verifies the selected repository is still reachable through an
   * installation this user can use, then confirms GitHub's REST metadata still matches
   * the selected id/full name. `action` runs with the verified user token.
   */
  private async withVerifiedRepository<T>(
    userId: string,
    repository: RepositorySelection,
    action: (
      token: string,
      repo: { owner: string; name: string; defaultBranch: string },
    ) => Promise<T>,
  ): Promise<T> {
    const selected = repositorySelectionSchema.parse(repository);
    const accessible = await this.access.accessibleRepositories(userId);
    if (
      !accessible.some(
        (item) =>
          item.installationId === selected.installationId &&
          item.id === selected.repositoryId &&
          item.fullName === selected.fullName,
      )
    )
      throw new AppError("ACCESS_DENIED");

    const result = await this.access.withToken(userId, async (token) => {
      const { defaultBranch } = await this.verifiedMetadata(token, selected);
      const [owner, name] = selected.fullName.split("/");
      return action(token, { owner, name, defaultBranch });
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /** At most one GraphQL request per `MAX_PATHS_PER_QUERY` paths; each aliased history costs 1 point. */
  private async lastCommitsForPaths(owner: string, name: string, paths: string[], token: string) {
    const results: Array<{ sha: string; message: string; date: string } | null> = [];
    for (let offset = 0; offset < paths.length; offset += MAX_PATHS_PER_QUERY) {
      const chunk = paths.slice(offset, offset + MAX_PATHS_PER_QUERY);
      const variables: Record<string, string> = { owner, name };
      chunk.forEach((value, index) => {
        variables[`p${index}`] = value;
      });
      const response = assertGraphQLOk(
        pathHistoryQuerySchema.parse(
          await this.github.graphql(buildPathHistoryQuery(chunk.length), variables, token),
        ),
      );
      const target = response.data?.repository?.defaultBranchRef?.target;
      chunk.forEach((_, index) => {
        const node = target?.[`p${index}`]?.nodes.at(0);
        results.push(
          node
            ? { sha: node.oid, message: node.messageHeadline, date: node.committedDate ?? "" }
            : null,
        );
      });
    }
    return results;
  }
}
