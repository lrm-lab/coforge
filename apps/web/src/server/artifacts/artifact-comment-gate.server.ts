import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { advanceCommentPosition } from "./artifact-comment-unseen.server";
import {
  advanceReadPosition,
  changedPathsOf,
  unseenVersions,
} from "./artifact-read-positions.server";
import { unseenCommentBlock } from "./artifact-unseen-block.server";

const VERSION_SCAN_LIMIT = 500;

export type WriteScope = {
  paths: readonly string[];
  threadIds: readonly string[];
  everything: boolean;
  versions: boolean;
};

export type GatedWrite = "push" | "comment" | "review" | "resolve";

const HELD: Record<GatedWrite, string> = {
  push: "Held, nothing was pushed",
  comment: "Held, the comment was not posted",
  review: "Held, nothing of the review was posted",
  resolve: "Held, the thread was not resolved",
};

type GateDb = Pick<
  PrismaClient,
  | "artifact"
  | "artifactComment"
  | "artifactCommentPosition"
  | "artifactCommentImage"
  | "artifactReadPosition"
  | "artifactVersion"
  | "agent"
  | "user"
>;

export class UnseenChanges extends AppError {
  constructor(
    details: NonNullable<ConstructorParameters<typeof AppError>[1]>["details"],
    hint: string,
    readonly seen: { commentId: string | null; version: number },
  ) {
    super("CONFLICT", { errorId: "artifact-unseen-changes", details, hint });
  }
}

const aboutScope = (scope: WriteScope): Prisma.ArtifactCommentWhereInput[] =>
  scope.everything
    ? [{}]
    : [
        { path: null },
        ...(scope.paths.length ? [{ path: { in: [...scope.paths] } }] : []),
        ...(scope.threadIds.length
          ? [{ rootId: { in: [...scope.threadIds] } }, { id: { in: [...scope.threadIds] } }]
          : []),
      ];

const commentIsAbout = (scope: WriteScope, row: { id: string; path: string | null }) =>
  scope.everything ||
  row.path === null ||
  scope.paths.includes(row.path) ||
  scope.threadIds.includes(row.id);

const versionIsAbout = (scope: WriteScope, paths: readonly string[]) =>
  scope.versions && (scope.everything || paths.some((path) => scope.paths.includes(path)));

export async function requireNoUnseenChanges(
  db: GateDb,
  input: {
    workspaceId: string;
    artifactId: string;
    agentId: string;
    action: GatedWrite;
    scopes: readonly WriteScope[];
    indexed?: boolean;
  },
): Promise<void> {
  const { workspaceId, artifactId, agentId, scopes } = input;
  const about: Prisma.ArtifactCommentWhereInput = { OR: scopes.flatMap(aboutScope) };
  const [comments, versions] = await Promise.all([
    unseenCommentBlock(db, { workspaceId, artifactId, agentId, about }),
    unseenOtherVersions(db, { workspaceId, artifactId, agentId, scopes }),
  ]);
  if (comments.count === 0 && !versions.relevant) return;
  const index = input.indexed
    ? scopes.findIndex(
        (scope, at) =>
          [...comments.comments, ...comments.excerpts].some((row) => commentIsAbout(scope, row)) ||
          versions.relevantScopes.includes(at),
      )
    : -1;
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const next =
    comments.unread > 0
      ? `${comments.unread} of the comments are only excerpted: read them in full first (coforge artifact comments ${artifactId}), then send the same request again`
      : "what is shown counts as seen: send the same request again";
  throw new UnseenChanges(
    {
      commentCount: comments.count,
      unread: comments.unread,
      versionCount: versions.count,
      skippedComments: comments.skipped,
      skippedVersions: Math.max(0, versions.count - versions.shown.length),
      unseen: JSON.stringify({
        comments: comments.comments,
        excerpts: comments.excerpts,
        versions: versions.shown,
      }),
      ...(index >= 0 ? { index } : {}),
    },
    `${HELD[input.action]}: ${plural(comments.count, "new comment")} and ${plural(versions.count, "new version")} from others about what this touches${index >= 0 ? ` (first: comments[${index}])` : ""}; ${next}`,
    { commentId: comments.seenThrough, version: versions.current },
  );
}

async function unseenOtherVersions(
  db: GateDb,
  input: {
    workspaceId: string;
    artifactId: string;
    agentId: string;
    scopes: readonly WriteScope[];
  },
) {
  const { artifactId, agentId, scopes } = input;
  const [position, artifact] = await Promise.all([
    db.artifactReadPosition.findUnique({
      where: { artifactId_agentId: { artifactId, agentId } },
      select: { version: true },
    }),
    db.artifact.findUniqueOrThrow({ where: { id: artifactId }, select: { currentVersion: true } }),
  ]);
  const after = position?.version ?? 0;
  const current = artifact.currentVersion;
  const listed = await unseenVersions(db, { ...input, after, current });
  const none = { count: 0, shown: [], relevant: false, relevantScopes: [] as number[], current };
  if (listed.versionCount === 0) return none;
  const rows = scopes.some((scope) => scope.versions)
    ? await db.artifactVersion.findMany({
        where: {
          artifactId,
          number: { gt: after, lte: current },
          OR: [{ publisherAgentId: null }, { publisherAgentId: { not: agentId } }],
        },
        orderBy: { number: "desc" },
        take: VERSION_SCAN_LIMIT,
        select: { changedPaths: true },
      })
    : [];
  const hits = scopes.flatMap((scope, at) =>
    rows.some((row) => versionIsAbout(scope, changedPathsOf(row.changedPaths))) ? [at] : [],
  );
  return {
    count: listed.versionCount,
    shown: listed.versions,
    relevant: hits.length > 0,
    relevantScopes: hits,
    current,
  };
}

export async function recordingRefusal<T>(
  db: Pick<PrismaClient, "$executeRaw">,
  input: { artifactId: string; agentId: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UnseenChanges) {
      const { commentId, version } = error.seen;
      if (commentId) await advanceCommentPosition(db, { ...input, commentId });
      await advanceReadPosition(db, { ...input, version });
    }
    throw error;
  }
}

export const pushScope = (paths: readonly string[]): WriteScope => ({
  paths,
  threadIds: [],
  everything: false,
  versions: false,
});

export const commentScope = (prepared: {
  path: string | null;
  rootId: string | null;
}): WriteScope => ({
  paths: prepared.path === null ? [] : [prepared.path],
  threadIds: prepared.rootId === null ? [] : [prepared.rootId],
  everything: prepared.path === null,
  versions: true,
});

export function requireNoUnseenChangesOnPush(
  db: GateDb,
  input: {
    workspaceId: string;
    artifactId: string;
    agentId: string;
    touched: readonly string[];
    entry: { current: string; pushed: string | undefined };
  },
) {
  const { current, pushed } = input.entry;
  return requireNoUnseenChanges(db, {
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    agentId: input.agentId,
    action: "push",
    scopes: [
      pushScope([
        ...input.touched,
        ...(pushed !== undefined && pushed !== current ? [current, pushed] : []),
      ]),
    ],
  });
}
