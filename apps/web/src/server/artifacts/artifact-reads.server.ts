import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { artifactIdsInBody } from "#src/features/artifacts/artifact-link";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { AppError } from "#src/lib/app-error";
import { containsPattern, searchTerms } from "#src/lib/search-terms";
import {
  actorConversationHomeReads,
  actorConversationHomeSql,
  type ActorConversationHomeRead,
} from "#src/server/conversations/channel-read-access.server";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import {
  artifactAuthorOwnerId,
  artifactHomeConversationId,
  artifactHomeView,
  artifactReadableFromHome,
  artifactTier,
  artifactsDisabled,
  artifactViewer,
  canManageArtifactSharingWithRole,
  homeStands,
  requireArtifactRead,
  requireConversationHome,
  type ArtifactActor,
  type ArtifactViewer,
} from "./artifact-access.server";

/** Artifacts one list or one batch of cards shows at most. */
const LIST_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const epochTimestamp = (at: Date) =>
  Prisma.sql`(TIMESTAMP 'epoch' + ${at.getTime()}::bigint * INTERVAL '1 millisecond')`;

/** A list cursor: the last artifact of a page, as its change time and id. Opaque to clients. */
const writeCursor = (row: { updatedAt: Date; id: string }) =>
  Buffer.from(JSON.stringify([row.updatedAt.getTime(), row.id])).toString("base64url");

function readCursor(cursor: string): { at: Date; id: string } {
  try {
    const [time, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown[];
    if (
      typeof time === "number" &&
      Number.isFinite(time) &&
      typeof id === "string" &&
      UUID.test(id)
    )
      return { at: new Date(time), id };
  } catch {
    // Not a cursor this server made.
  }
  throw new AppError("INVALID_INPUT", { errorId: "artifact-list-cursor" });
}

export type ArtifactMessageCard =
  | {
      kind: "artifact";
      state: "open";
      artifactId: string;
      href: string;
      title: string;
      preview: string;
      contentType: string;
      version: number;
      source: { conversationId?: string; agentId?: string; label: string };
      canOpen: true;
    }
  | { kind: "artifact"; state: "forbidden"; artifactId: string; canOpen: false }
  | { kind: "artifact"; state: "deleted"; artifactId: string; canOpen: false };

/** What a card and a list row show of an artifact: never its content beyond the preview. */
const CARD_SELECT = {
  id: true,
  name: true,
  title: true,
  entryPath: true,
  homeKey: true,
  access: true,
  currentVersion: true,
  preview: true,
  authorAgentId: true,
  updatedAt: true,
} as const;

function card(
  row: {
    id: string;
    name: string;
    title: string;
    entryPath: string;
    homeKey: string;
    access: string;
    currentVersion: number;
    preview: string;
    authorAgentId: string | null;
    updatedAt: Date;
  },
  canChange: boolean,
  homeKey: string | null = artifactTier(row) === "workspace" ? "workspace" : row.homeKey,
) {
  const { authorAgentId, ...shown } = row;
  return {
    ...shown,
    homeKey,
    access: artifactTier(row),
    canChange,
    author: authorAgentId ? { agentId: authorAgentId } : null,
  };
}

const accessRuleInput = (
  row: { authorAgentId: string | null },
  owners: ReadonlyMap<string, string>,
) => ({
  authorAgentOwnerId: (row.authorAgentId ? owners.get(row.authorAgentId) : undefined) ?? null,
});

/**
 * Reading artifacts (task #385): one version with its files, a list, and cards. Each asks the
 * experiment, then the reader's access to the artifact's home, as every operation does.
 */
export class ArtifactReads {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
  ) {}

  /** A live artifact the reader may read, with what a read shows of it, and the viewer's
   * Workspace standing (`artifactViewer`) every check of the read shared. */
  async artifact(workspaceId: string, artifactId: string, reader: ArtifactActor) {
    if (!(await this.enabled(workspaceId))) throw artifactsDisabled();
    const [artifact, viewer] = await Promise.all([
      this.db.artifact.findFirst({
        where: { id: artifactId, workspaceId, deletedAt: null },
        select: {
          id: true,
          name: true,
          title: true,
          description: true,
          entryPath: true,
          homeKey: true,
          access: true,
          currentVersion: true,
          authorAgentId: true,
        },
      }),
      artifactViewer(this.db, workspaceId, reader),
    ]);
    if (!artifact) throw new AppError("NOT_FOUND");
    const authorAgentOwnerId = await artifactAuthorOwnerId(this.db, artifact.authorAgentId);
    const view = await requireArtifactRead(this.db, workspaceId, reader, artifact, {
      viewer,
      authorAgentOwnerId,
    });
    return {
      ...artifact,
      homeKey: view.homeKey,
      access: view.tier,
      homeKind: view.homeKind,
      canChange: canManageArtifactSharingWithRole(reader, viewer.role, { authorAgentOwnerId }),
      authorAgentOwnerId,
      viewer,
    };
  }

  /** The artifact and one version (its current one by default) with that version's files, and
   * the viewer standing the read resolved (`artifactViewer`), so a caller's own rule — a
   * delete's — needs no second membership read. */
  async read(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    version?: number;
  }) {
    const { viewer, authorAgentOwnerId, ...artifact } = await this.artifact(
      input.workspaceId,
      input.artifactId,
      input.reader,
    );
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return { artifact, version: null, files: [], viewer, authorAgentOwnerId };
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId: artifact.id, number } },
      select: {
        id: true,
        number: true,
        note: true,
        label: true,
        entryPath: true,
        title: true,
        description: true,
        merged: true,
        createdAt: true,
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const files = await this.db.artifactFile.findMany({
      where: { versionId: version.id },
      select: { path: true, sha256: true, sizeBytes: true, kind: true },
      orderBy: { path: "asc" },
    });
    return { artifact, version, files, viewer, authorAgentOwnerId };
  }

  /** One file of a version (the current one by default), or null when the version has no file at
   * `path`; a version that does not exist is `NOT_FOUND`, as in `read`. */
  async file(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    version?: number;
    path: string;
  }) {
    const artifact = await this.artifact(input.workspaceId, input.artifactId, input.reader);
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return null;
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId: artifact.id, number } },
      select: {
        files: {
          where: { path: input.path },
          select: { path: true, sha256: true, sizeBytes: true, kind: true },
        },
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    return version.files[0] ?? null;
  }

  /** One file of a pinned version with no reader: the sandbox's subresources come under a
   * signed ticket that already proved its reader may read the artifact, so this asks only that
   * the experiment is on, the artifact is live in the workspace and the version has the file —
   * never who asks (task #25). */
  async fileInVersion(input: {
    workspaceId: string;
    artifactId: string;
    version: number;
    path: string;
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    return this.db.artifactFile.findFirst({
      where: {
        artifactId: input.artifactId,
        path: input.path,
        version: {
          number: input.version,
          artifact: { workspaceId: input.workspaceId, deletedAt: null },
        },
      },
      select: { sha256: true, sizeBytes: true },
    });
  }

  async list(input: { workspaceId: string; reader: ArtifactActor; conversationId?: string }) {
    return (await this.listPage({ ...input, limit: LIST_LIMIT })).artifacts;
  }

  /**
   * One page of `list`, `limit` artifacts at a time: only those whose title holds every word of
   * `query` (any case), after the artifact `cursor` names (a previous page's `nextCursor`, absent
   * on the last page). Pages are stable while artifacts change: the cursor is the position in
   * the newest-changed-first order, not an offset.
   */
  async listPage(input: {
    workspaceId: string;
    reader: ArtifactActor;
    conversationId?: string;
    query?: string;
    cursor?: string;
    limit: number;
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const viewer = await artifactViewer(this.db, input.workspaceId, input.reader);
    if (!viewer.member) throw new AppError("NOT_FOUND");
    if (input.conversationId)
      await requireConversationHome(
        this.db,
        input.workspaceId,
        input.reader,
        input.conversationId,
        "read",
        viewer,
      );
    const after = input.cursor === undefined ? undefined : readCursor(input.cursor);
    const ids = await this.#listedIds(input, viewer, after);
    const found = await this.db.artifact.findMany({
      where: { workspaceId: input.workspaceId, id: { in: ids.slice(0, input.limit) } },
      select: CARD_SELECT,
    });
    const foundById = new Map(found.map((row) => [row.id, row]));
    const page = ids.slice(0, input.limit).flatMap((id) => foundById.get(id) ?? []);
    const owners = await this.#authorOwners(page);
    const last = page.at(-1);
    return {
      artifacts: page.map((row) =>
        card(
          row,
          canManageArtifactSharingWithRole(input.reader, viewer.role, accessRuleInput(row, owners)),
        ),
      ),
      ...(ids.length > input.limit && last ? { nextCursor: writeCursor(last) } : {}),
    };
  }

  /** Cards of the named artifacts the reader may read, in the order named; any other is left
   * out, as if it did not exist. */
  async cards(input: {
    workspaceId: string;
    reader: ArtifactActor;
    artifactIds: readonly string[];
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const ids = [...new Set(input.artifactIds.map((id) => id.toLowerCase()))]
      .filter((id) => UUID.test(id))
      .slice(0, LIST_LIMIT);
    if (ids.length === 0) return [];
    const [rows, viewer] = await Promise.all([
      this.db.artifact.findMany({
        where: { workspaceId: input.workspaceId, id: { in: ids }, deletedAt: null },
        select: CARD_SELECT,
      }),
      artifactViewer(this.db, input.workspaceId, input.reader),
    ]);
    if (!viewer.member) return [];
    const [owners, homes] = await Promise.all([
      this.#authorOwners(rows),
      this.#homeReads(input.workspaceId, input.reader, rows),
    ]);
    const kept = new Map<string, ReturnType<typeof card>>();
    for (const row of rows) {
      const home = homes.get(artifactHomeConversationId(row.homeKey) ?? "");
      const rule = accessRuleInput(row, owners);
      if (
        !artifactReadableFromHome({
          actor: input.reader,
          viewer,
          artifact: row,
          home,
          authorAgentOwnerId: rule.authorAgentOwnerId,
        })
      )
        continue;
      kept.set(
        row.id,
        card(
          row,
          canManageArtifactSharingWithRole(input.reader, viewer.role, rule),
          artifactHomeView(row, home).homeKey,
        ),
      );
    }
    return ids.flatMap((id) => (kept.has(id) ? [kept.get(id)!] : []));
  }

  /**
   * The live projections embedded in one browser message page. The three reads are deliberately
   * fixed: artifact rows, the viewer's Workspace membership, and all referenced conversations.
   * Access is then decided in memory so a page with twenty links does not create twenty reads.
   */
  async messageCards(input: {
    workspaceId: string;
    reader: ArtifactActor;
    messages: readonly { body: string }[];
  }): Promise<ArtifactMessageCard[][]> {
    const ids = [
      ...new Set(input.messages.flatMap((message) => artifactIdsInBody(message.body, 100))),
    ];
    if (ids.length === 0) return input.messages.map(() => []);
    if (!(await this.enabled(input.workspaceId))) return input.messages.map(() => []);
    const rows = await this.db.artifact.findMany({
      where: { workspaceId: input.workspaceId, id: { in: ids } },
      select: {
        id: true,
        title: true,
        preview: true,
        entryPath: true,
        currentVersion: true,
        homeKey: true,
        access: true,
        deletedAt: true,
        authorAgentId: true,
        workspace: { select: { slug: true } },
      },
    });
    const viewer = await artifactViewer(this.db, input.workspaceId, input.reader);
    const [owners, conversations] = await Promise.all([
      viewer.member &&
      input.reader.userId !== undefined &&
      !isWorkspaceAdminRole(viewer.role ?? undefined)
        ? this.#authorOwners(rows)
        : new Map<string, string>(),
      viewer.member
        ? this.#homeReads(input.workspaceId, input.reader, rows)
        : new Map<string, ActorConversationHomeRead>(),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const cardFor = (id: string): ArtifactMessageCard => {
      const row = byId.get(id);
      if (!row)
        return {
          kind: "artifact",
          state: "forbidden",
          artifactId: id,
          canOpen: false,
        };
      const conversationId = artifactHomeConversationId(row.homeKey);
      const conversation = conversationId ? conversations.get(conversationId) : undefined;
      const readable = artifactReadableFromHome({
        actor: input.reader,
        viewer,
        artifact: row,
        home: conversation,
        authorAgentOwnerId: accessRuleInput(row, owners).authorAgentOwnerId,
      });
      if (!readable)
        return { kind: "artifact", state: "forbidden", artifactId: id, canOpen: false };
      if (row.deletedAt !== null)
        return { kind: "artifact", state: "deleted", artifactId: id, canOpen: false };
      const homed = artifactTier(row) === "conversation" && homeStands(conversation);
      return {
        kind: "artifact",
        state: "open",
        artifactId: id,
        href: `/w/${row.workspace.slug}/artifacts/${id}`,
        title: row.title,
        preview: row.preview,
        contentType: artifactKindOfPath(row.entryPath),
        version: row.currentVersion,
        source:
          homed && conversationId
            ? {
                conversationId,
                label: conversation?.channelName ? `#${conversation.channelName}` : "DM",
              }
            : row.authorAgentId
              ? { agentId: row.authorAgentId, label: "Agent" }
              : { label: "Workspace" },
        canOpen: true,
      };
    };
    return input.messages.map((message) => artifactIdsInBody(message.body, 100).map(cardFor));
  }

  async #authorOwners(rows: ReadonlyArray<{ authorAgentId: string | null }>) {
    const ids = [...new Set(rows.flatMap((row) => (row.authorAgentId ? [row.authorAgentId] : [])))];
    if (ids.length === 0) return new Map<string, string>();
    const agents = await this.db.agent.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerId: true },
    });
    return new Map(agents.map((agent) => [agent.id, agent.ownerId]));
  }

  async #homeReads(
    workspaceId: string,
    reader: ArtifactActor,
    rows: ReadonlyArray<{ homeKey: string; access: string }>,
  ) {
    const conversationIds = [
      ...new Set(
        rows.flatMap((row) => {
          const conversationId =
            artifactTier(row) === "workspace" ? undefined : artifactHomeConversationId(row.homeKey);
          return conversationId ? [conversationId] : [];
        }),
      ),
    ];
    return actorConversationHomeReads(this.db, workspaceId, reader, conversationIds);
  }

  async #listedIds(
    input: {
      workspaceId: string;
      reader: ArtifactActor;
      conversationId?: string;
      query?: string;
      limit: number;
    },
    viewer: ArtifactViewer,
    after: { at: Date; id: string } | undefined,
  ): Promise<string[]> {
    const { workspaceId, reader } = input;
    const home = actorConversationHomeSql("home", workspaceId, reader);
    const homeKeyOfConversation = Prisma.sql`'conversation:' || home."id"::text`;
    const goneReach = await this.#goneHomeReach(workspaceId, reader, viewer);
    const visible = input.conversationId
      ? Prisma.sql`a."homeKey" = ${`conversation:${input.conversationId}`}`
      : Prisma.sql`(a."access" = 'workspace' OR a."homeKey" = 'workspace'
          OR EXISTS (
            SELECT 1 FROM "conversations" home
            WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.reads})
          OR (${goneReach} AND a."homeKey" LIKE 'conversation:%' AND NOT EXISTS (
            SELECT 1 FROM "conversations" home
            WHERE a."homeKey" = ${homeKeyOfConversation} AND ${home.stands})))`;
    const titled = searchTerms(input.query ?? "").map(
      (word) => Prisma.sql`a."title" ILIKE ${containsPattern(word)}`,
    );
    const afterCursor = after
      ? [
          Prisma.sql`(a."updatedAt" < ${epochTimestamp(after.at)}
            OR (a."updatedAt" = ${epochTimestamp(after.at)} AND a."id" < ${after.id}::uuid))`,
        ]
      : [];
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT a."id" FROM "artifacts" a
      WHERE a."workspaceId" = ${workspaceId}::uuid AND a."deletedAt" IS NULL
        AND ${Prisma.join([visible, ...titled, ...afterCursor], " AND ")}
      ORDER BY a."updatedAt" DESC, a."id" DESC
      LIMIT ${input.limit + 1}`;
    return rows.map((row) => row.id);
  }

  async #goneHomeReach(workspaceId: string, reader: ArtifactActor, viewer: ArtifactViewer) {
    if (reader.agentId !== undefined)
      return Prisma.sql`a."authorAgentId" = ${reader.agentId}::uuid`;
    if (isWorkspaceAdminRole(viewer.role ?? undefined)) return Prisma.sql`TRUE`;
    return Prisma.sql`a."authorAgentId" IN (
      SELECT "id" FROM "agents"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "ownerId" = ${reader.userId}::uuid)`;
  }
}
