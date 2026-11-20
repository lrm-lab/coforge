import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type { ArtifactEntryFacts } from "#src/features/artifacts/artifact-entry-facts";
import { artifactIdsInBody } from "#src/features/artifacts/artifact-link";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { AppError } from "#src/lib/app-error";
import { containsPattern, searchTerms } from "#src/lib/search-terms";
import {
  actorConversationHomeReads,
  type ActorConversationHomeRead,
} from "#src/server/conversations/channel-read-access.server";
import { isWorkspaceAdminRole } from "#src/features/workspaces/workspace-roles";
import { actorNames, actorOf } from "./artifact-actor-names.server";
import { epochTimestamp, visibleToReaderSql } from "./artifact-visible.server";
import {
  artifactAuthorOwnerId,
  artifactHomeConversationId,
  artifactHomeView,
  artifactReadableFromHome,
  artifactTier,
  artifactAccessTier,
  artifactViewer,
  canManageArtifactSharingWithRole,
  homeStands,
  requireArtifactRead,
  requireConversationHome,
  type ArtifactActor,
  type ArtifactHomeKind,
  type ArtifactViewer,
} from "./artifact-access.server";

const LIST_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  } catch {}
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

const CARD_SELECT = {
  id: true,
  name: true,
  title: true,
  entryPath: true,
  homeKey: true,
  access: true,
  currentVersion: true,
  preview: true,
  entryFacts: true,
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
    entryFacts: Prisma.JsonValue;
    authorAgentId: string | null;
    updatedAt: Date;
  },
  canChange: boolean,
  homeKey: string | null = artifactTier(row) === "workspace" ? "workspace" : row.homeKey,
) {
  const { authorAgentId, entryFacts, ...shown } = row;
  return {
    ...shown,
    entryFacts: entryFacts as ArtifactEntryFacts | null,
    homeKey,
    entryKind: artifactKindOfPath(row.entryPath),
    access: artifactAccessTier(row),
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

export type ArtifactOrigin =
  | {
      messageId: string;
      conversationId: string;
      homeKind: Exclude<ArtifactHomeKind, "workspace">;
      threadRootId?: string;
    }
  | { hidden: true };

export class ArtifactReads {
  constructor(private readonly db: PrismaClient) {}

  async #origin(
    messageId: string | null,
    home: string | undefined,
    homeKind: ArtifactHomeKind,
  ): Promise<ArtifactOrigin | null> {
    if (messageId === null) return null;
    if (home === undefined || homeKind === "workspace") return { hidden: true };
    const message = await this.db.message.findFirst({
      where: { id: messageId, conversationId: home },
      select: { threadRootId: true },
    });
    return {
      messageId,
      conversationId: home,
      homeKind,
      ...(message?.threadRootId ? { threadRootId: message.threadRootId } : {}),
    };
  }

  async artifact(workspaceId: string, artifactId: string, reader: ArtifactActor) {
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
          originMessageId: true,
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
    const canChange = canManageArtifactSharingWithRole(reader, viewer.role, {
      authorAgentOwnerId,
    });
    const { originMessageId, ...shown } = artifact;
    const originHome = artifactHomeConversationId(view.homeKey ?? "");
    const origin = await this.#origin(originMessageId, originHome, view.homeKind);
    return {
      ...shown,
      origin,
      homeKey: view.homeKey,
      access: view.tier,
      homeKind: view.homeKind,
      canChange,
      narrowable: canChange && view.narrowable,
      authorAgentOwnerId,
      viewer,
    };
  }

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
        publisherAgentId: true,
        publisherUserId: true,
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const [files, names] = await Promise.all([
      this.db.artifactFile.findMany({
        where: { versionId: version.id },
        select: { path: true, sha256: true, sizeBytes: true, kind: true },
        orderBy: { path: "asc" },
      }),
      actorNames(this.db, input.workspaceId, {
        userIds: version.publisherUserId ? [version.publisherUserId] : [],
        agentIds: version.publisherAgentId ? [version.publisherAgentId] : [],
      }),
    ]);
    const { publisherAgentId, publisherUserId, ...shownVersion } = version;
    return {
      artifact,
      version: {
        ...shownVersion,
        publisher: actorOf(names, { userId: publisherUserId, agentId: publisherAgentId }),
      },
      files,
      viewer,
      authorAgentOwnerId,
    };
  }

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

  async fileInVersion(input: {
    workspaceId: string;
    artifactId: string;
    version: number;
    path: string;
  }) {
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

  async listPage(input: {
    workspaceId: string;
    reader: ArtifactActor;
    conversationId?: string;
    query?: string;
    title?: string;
    cursor?: string;
    limit: number;
  }) {
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

  async cards(input: {
    workspaceId: string;
    reader: ArtifactActor;
    artifactIds: readonly string[];
  }) {
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

  async messageCards(input: {
    workspaceId: string;
    reader: ArtifactActor;
    messages: readonly { body: string }[];
  }): Promise<ArtifactMessageCard[][]> {
    const ids = [
      ...new Set(input.messages.flatMap((message) => artifactIdsInBody(message.body, 100))),
    ];
    if (ids.length === 0) return input.messages.map(() => []);
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
      title?: string;
      limit: number;
    },
    viewer: ArtifactViewer,
    after: { at: Date; id: string } | undefined,
  ): Promise<string[]> {
    const { workspaceId } = input;
    const visible = visibleToReaderSql({
      workspaceId,
      reader: input.reader,
      viewer,
      conversationId: input.conversationId,
    });
    const titled = [
      ...(input.title === undefined ? [] : [Prisma.sql`a."title" = ${input.title}`]),
      ...searchTerms(input.query ?? "").map(
        (word) => Prisma.sql`a."title" ILIKE ${containsPattern(word)}`,
      ),
    ];
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
}
