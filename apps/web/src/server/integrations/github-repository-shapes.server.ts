import { z } from "zod";
import { AppError } from "#src/lib/app-error";
import { gitObjectIdSchema } from "#src/lib/git-object-id";
import { idSchema } from "./github-account-shapes.server";

export const repositorySelectionSchema = z.object({
  installationId: idSchema,
  repositoryId: idSchema,
  fullName: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(300),
});
/** The repository a Project links to, as selected through one App installation. */
export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;
export const repositoryMetadataSchema = z.object({
  id: idSchema,
  full_name: z.string().min(3).max(300),
  default_branch: z.string().min(1).max(255),
});
/** GraphQL `avatarUrl` values are validated against the CDN host GitHub actually serves from. */
const avatarUrlSchema = z
  .string()
  .nullable()
  .transform((value) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com"
        ? value
        : null;
    } catch {
      return null;
    }
  });
const graphqlErrorSchema = z.object({ type: z.string().optional() });
const graphqlIdentitySchema = z.object({ login: z.string().min(1).max(100) }).nullable();
const graphqlGitActorSchema = z.object({
  name: z.string().nullable(),
  email: z.string().max(320).nullable(),
  avatarUrl: avatarUrlSchema,
  user: graphqlIdentitySchema,
});
const graphqlCommitNodeSchema = z.object({
  oid: gitObjectIdSchema,
  messageHeadline: z.string().max(100_000),
  committedDate: z.iso.datetime().nullable(),
  author: graphqlGitActorSchema.nullable(),
  /** Git author plus `Co-authored-by` trailers; the git author is always first. */
  authors: z.object({ nodes: z.array(graphqlGitActorSchema).max(5) }),
  committer: z
    .object({
      name: z.string().nullable(),
      email: z.string().max(320).nullable(),
      user: graphqlIdentitySchema,
    })
    .nullable(),
  signature: z.object({ isValid: z.boolean() }).nullable(),
  statusCheckRollup: z.object({ state: z.string() }).nullable(),
});
const graphqlTreeEntrySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
  type: z.enum(["blob", "tree", "commit"]),
  mode: z.number().int(),
});
export const repositoryOverviewQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          defaultBranchRef: z
            .object({
              target: z
                .object({
                  history: z.object({ nodes: z.array(graphqlCommitNodeSchema) }).optional(),
                })
                .nullable(),
            })
            .nullable(),
          object: z.object({ entries: z.array(graphqlTreeEntrySchema).optional() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
const graphqlPathCommitSchema = z.object({
  oid: gitObjectIdSchema,
  messageHeadline: z.string().max(100_000),
  committedDate: z.iso.datetime().nullable(),
});
export const pathHistoryQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          defaultBranchRef: z
            .object({
              target: z
                .record(z.string(), z.object({ nodes: z.array(graphqlPathCommitSchema) }))
                .nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
/**
 * `object(expression:|oid:)` on a `GitObject`. Only the `Tree`/`Blob` fragments are ever
 * requested, so a Commit/Tag target parses with neither `entries` nor `byteSize` present.
 */
const graphqlPathObjectSchema = z
  .object({
    oid: gitObjectIdSchema.optional(),
    entries: z.array(graphqlTreeEntrySchema).optional(),
    byteSize: z.number().int().nonnegative().optional(),
    isBinary: z.boolean().nullable().optional(),
    isTruncated: z.boolean().optional(),
    text: z.string().nullable().optional(),
  })
  .nullable();
export const repositoryObjectQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({ databaseId: idSchema.nullable(), object: graphqlPathObjectSchema })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
export const graphqlPathLatestCommitSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          databaseId: idSchema.nullable(),
          defaultBranchRef: z
            .object({
              target: z
                .object({
                  history: z
                    .object({
                      nodes: z.array(
                        z.object({
                          oid: gitObjectIdSchema,
                          messageHeadline: z.string().max(100_000),
                          committedDate: z.iso.datetime().nullable(),
                          /** Git author plus `Co-authored-by` trailers; the git author is first. */
                          authors: z.object({ nodes: z.array(graphqlGitActorSchema).max(5) }),
                          committer: graphqlGitActorSchema.nullable(),
                        }),
                      ),
                    })
                    .optional(),
                })
                .nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
export const restTreeSchema = z.object({
  sha: gitObjectIdSchema,
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1).max(4096),
      mode: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: gitObjectIdSchema,
    }),
  ),
});

/**
 * Rejects a GraphQL response with a top-level error and no repository data. Field-level
 * errors (e.g. `statusCheckRollup` when the App lacks Checks read) leave `data.repository`
 * populated and are tolerated — the affected field just parses as null.
 */
export function assertGraphQLOk<
  T extends { data: { repository: unknown } | null; errors?: Array<{ type?: string }> },
>(response: T): T {
  if (response.errors?.length && !response.data?.repository) {
    const denied = response.errors.some(
      (error) =>
        error.type === "FORBIDDEN" ||
        error.type === "NOT_FOUND" ||
        error.type === "INSUFFICIENT_SCOPES",
    );
    throw new AppError(denied ? "ACCESS_DENIED" : "TEMPORARILY_UNAVAILABLE");
  }
  return response;
}

export function mapChecksState(
  state: string | null | undefined,
): "success" | "failure" | "pending" | null {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

function mapTreeEntryType(
  entry: z.infer<typeof graphqlTreeEntrySchema>,
): "file" | "dir" | "symlink" | "submodule" {
  if (entry.type === "tree") return "dir";
  if (entry.type === "commit") return "submodule";
  return entry.mode === 40960 ? "symlink" : "file";
}

/** Maps raw Tree entries to the UI shape and sorts dirs first, then name order. */
export function mapEntries(entries: Array<z.infer<typeof graphqlTreeEntrySchema>>) {
  return entries
    .map((entry) => ({ name: entry.name, path: entry.path, type: mapTreeEntryType(entry) }))
    .sort(
      (a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name),
    );
}

export const REPOSITORY_OVERVIEW_QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 5) {
              nodes {
                oid
                messageHeadline
                committedDate
                author { name email avatarUrl(size: 80) user { login } }
                authors(first: 5) { nodes { name email avatarUrl(size: 80) user { login } } }
                committer { name email user { login } }
                signature { isValid }
                statusCheckRollup { state }
              }
            }
          }
        }
      }
      object(expression: $expression) {
        ... on Tree { entries { name type path mode } }
      }
    }
  }
`;

/** Builds a `history(first: 1, path: $pN)` alias per path, chunked by the caller. */
export function buildPathHistoryQuery(count: number): string {
  const variableDeclarations = Array.from(
    { length: count },
    (_, index) => `$p${index}: String!`,
  ).join(", ");
  const aliasFields = Array.from(
    { length: count },
    (_, index) =>
      `p${index}: history(first: 1, path: $p${index}) { nodes { oid messageHeadline committedDate } }`,
  ).join("\n");
  return `
    query($owner: String!, $name: String!, ${variableDeclarations}) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              ${aliasFields}
            }
          }
        }
      }
    }
  `;
}

/** The newest commit touching `$path`; a null path is the whole branch (the repository root). */
export const PATH_LATEST_COMMIT_QUERY = `
  query($owner: String!, $name: String!, $path: String) {
    repository(owner: $owner, name: $name) {
      databaseId
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 1, path: $path) {
              nodes {
                oid
                messageHeadline
                committedDate
                authors(first: 5) { nodes { name avatarUrl(size: 80) user { login } } }
                committer { name avatarUrl(size: 80) user { login } }
              }
            }
          }
        }
      }
    }
  }
`;

const MAX_PATH_LENGTH = 4096;
export const MAX_BLOB_PREVIEW_BYTES = 1_048_576;

/**
 * Rejects absolute paths, `.`/`..` segments, empty segments, and control characters
 * before any GitHub read. `""` is the repository root and is always valid.
 */
export function validateRepositoryPath(path: string): string {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) throw new AppError("NOT_FOUND");
  // eslint-disable-next-line no-control-regex -- deliberately rejecting control characters, including NUL.
  if (/[\x00-\x1f\x7f]/.test(path)) throw new AppError("NOT_FOUND");
  if (path === "") return path;
  if (path.startsWith("/")) throw new AppError("NOT_FOUND");
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new AppError("NOT_FOUND");
  return path;
}

/**
 * One request per file click: the repository's `databaseId` rides along so the identity
 * check needs no separate REST call. Exactly one of `$expression` / `$oid` is non-null.
 */
export const REPOSITORY_OBJECT_QUERY = `
  query($owner: String!, $name: String!, $expression: String, $oid: GitObjectID) {
    repository(owner: $owner, name: $name) {
      databaseId
      object(expression: $expression, oid: $oid) {
        oid
        ... on Tree { entries { name type path mode } }
        ... on Blob { byteSize isBinary isTruncated text }
      }
    }
  }
`;

// Compute a last-touching commit for at most this many root entries (dirs first, then name
// order — the same order the UI shows), chunked into GraphQL requests of this size.
export const MAX_LAST_COMMIT_PATHS = 100;
export const MAX_PATHS_PER_QUERY = 50;

/** `a/b c.ts` → `a/b%20c.ts`: each segment encoded, the separators kept. */
export function encodeRepositoryPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
