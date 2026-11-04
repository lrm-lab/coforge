import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  artifactHomeAccess,
  artifactsDisabled,
  canChangeArtifactAccess,
  canChangeArtifactAccessWithRole,
  inWorkspace,
  requireArtifactHome,
  requireArtifactRead,
  type ArtifactAccessTier,
  type ArtifactActor,
  type ArtifactHomeAccess,
} from "./artifact-access.server";

/** Versions one history page lists by default, and at most. */
const HISTORY_PAGE = 50;
/** Artifacts one list or one batch of cards shows at most. */
const LIST_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a card and a list row show of an artifact: never its content beyond the preview. */
const CARD_SELECT = {
  id: true,
  name: true,
  title: true,
  kind: true,
  homeKey: true,
  access: true,
  currentVersion: true,
  preview: true,
  authorUserId: true,
  authorAgentId: true,
  updatedAt: true,
} as const;

function card(
  row: {
    id: string;
    name: string;
    title: string;
    kind: string;
    homeKey: string;
    access: string;
    currentVersion: number;
    preview: string;
    authorUserId: string | null;
    authorAgentId: string | null;
    updatedAt: Date;
  },
  canChange: boolean,
  homeRead = true,
) {
  const { authorUserId, authorAgentId, ...shown } = row;
  return {
    ...shown,
    // A reader the widened tier let in never learns the home's key (task #529).
    homeKey: homeRead ? row.homeKey : null,
    access: row.access as ArtifactAccessTier,
    canChange,
    author: authorAgentId
      ? { agentId: authorAgentId }
      : authorUserId
        ? { userId: authorUserId }
        : null,
  };
}

/** What the `canChange` rule reads off a card row: the two author columns and the authoring
 * Agent's owner, looked up once per batch (`authorAgentId` is a bare column, task #529). */
const accessRuleInput = (
  row: { authorUserId: string | null; authorAgentId: string | null },
  owners: ReadonlyMap<string, string>,
) => ({
  authorUserId: row.authorUserId,
  authorAgentId: row.authorAgentId,
  authorAgentOwnerId: (row.authorAgentId ? owners.get(row.authorAgentId) : undefined) ?? null,
});

/**
 * Reading artifacts (task #385): one version with its files, and the history, newest first. Both
 * ask the experiment, then the reader's access to the artifact's home, as every operation does.
 */
export class ArtifactReads {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
  ) {}

  /** A live artifact the reader may read, with what a read shows of it. */
  async artifact(workspaceId: string, artifactId: string, reader: ArtifactActor) {
    if (!(await this.enabled(workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: artifactId, workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        title: true,
        description: true,
        kind: true,
        entryPath: true,
        homeKey: true,
        access: true,
        currentVersion: true,
        // Read with the artifact so `canDelete` needs no second query (task #385).
        authorUserId: true,
        authorAgentId: true,
      },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    // The access check already read the home's conversation, so its kind comes free (task #385).
    const { homeKind, homeRead, write } = await requireArtifactRead(
      this.db,
      workspaceId,
      reader,
      artifact,
    );
    // `authorAgentId` is a bare column, so the owner's id is one more lookup — and only where the
    // `canChange` rule needs it (task #529).
    const ownerId = artifact.authorAgentId
      ? (
          await this.db.agent.findFirst({
            where: { id: artifact.authorAgentId },
            select: { ownerId: true },
          })
        )?.ownerId
      : undefined;
    return {
      ...artifact,
      // A reader the widened tier let in never learns the home's key: a private conversation's
      // id is not theirs to know (task #529).
      homeKey: homeRead ? artifact.homeKey : null,
      homeRead,
      // Whether the home's own rule lets this reader write; a tier only ever widens reading.
      canWrite: write,
      access: artifact.access as ArtifactAccessTier,
      canChange: await canChangeArtifactAccess(this.db, workspaceId, reader, {
        authorUserId: artifact.authorUserId,
        authorAgentId: artifact.authorAgentId,
        authorAgentOwnerId: ownerId ?? null,
      }),
      homeKind,
    };
  }

  /** The artifact and one version (its current one by default) with that version's files. */
  async read(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    version?: number;
  }) {
    const artifact = await this.artifact(input.workspaceId, input.artifactId, input.reader);
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return { artifact, version: null, files: [] };
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
        revertedFrom: true,
        createdAt: true,
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const files = await this.db.artifactFile.findMany({
      where: { versionId: version.id },
      select: { path: true, sha256: true, sizeBytes: true, kind: true },
      orderBy: { path: "asc" },
    });
    return { artifact, version, files };
  }

  /** The live artifacts of one home the reader may read (a conversation's, or the Workspace's
   * when none is named), most recently changed first, at most 100. */
  async list(input: { workspaceId: string; reader: ArtifactActor; conversationId?: string }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const homeKey = input.conversationId ? `conversation:${input.conversationId}` : "workspace";
    await requireArtifactHome(this.db, input.workspaceId, input.reader, homeKey, "read");
    const rows = await this.db.artifact.findMany({
      where: { workspaceId: input.workspaceId, homeKey, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: LIST_LIMIT,
      select: CARD_SELECT,
    });
    const [role, owners] = await Promise.all([
      this.#actorRole(input.workspaceId, input.reader),
      this.#authorOwners(rows),
    ]);
    return rows.map((row) =>
      card(row, canChangeArtifactAccessWithRole(input.reader, role, accessRuleInput(row, owners))),
    );
  }

  /** Cards of the named artifacts the reader may read, in the order named; any other is left
   * out, as if it did not exist. */
  async cards(input: {
    workspaceId: string;
    reader: ArtifactActor;
    artifactIds: readonly string[];
  }) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
    const ids = [...new Set(input.artifactIds)].filter((id) => UUID.test(id)).slice(0, LIST_LIMIT);
    if (ids.length === 0) return [];
    const rows = await this.db.artifact.findMany({
      where: { workspaceId: input.workspaceId, id: { in: ids }, deletedAt: null },
      select: CARD_SELECT,
    });
    const homes = new Map<string, Promise<ArtifactHomeAccess>>();
    const homeAccess = (homeKey: string) => {
      if (!homes.has(homeKey))
        homes.set(homeKey, artifactHomeAccess(this.db, input.workspaceId, input.reader, homeKey));
      return homes.get(homeKey)!;
    };
    const member = await inWorkspace(this.db, input.workspaceId, input.reader);
    const [role, owners] = await Promise.all([
      this.#actorRole(input.workspaceId, input.reader),
      this.#authorOwners(rows),
    ]);
    const kept = new Map<string, ReturnType<typeof card>>();
    for (const row of rows) {
      const home = await homeAccess(row.homeKey);
      // A home's readers share one check; a `workspace` tier widens it per artifact (task #529).
      if (!(home.read || (row.access === "workspace" && member))) continue;
      kept.set(
        row.id,
        card(
          row,
          canChangeArtifactAccessWithRole(input.reader, role, accessRuleInput(row, owners)),
          home.read,
        ),
      );
    }
    return ids.flatMap((id) => (kept.has(id) ? [kept.get(id)!] : []));
  }

  /** The authoring Agents' owners, for the batch's `canChange` answers: one lookup per batch. */
  async #authorOwners(rows: ReadonlyArray<{ authorAgentId: string | null }>) {
    const ids = [...new Set(rows.flatMap((row) => (row.authorAgentId ? [row.authorAgentId] : [])))];
    if (ids.length === 0) return new Map<string, string>();
    const agents = await this.db.agent.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerId: true },
    });
    return new Map(agents.map((agent) => [agent.id, agent.ownerId]));
  }

  /** The actor's Workspace role once for a batch of cards; `null` when the actor is an Agent. */
  async #actorRole(workspaceId: string, actor: ArtifactActor) {
    return actor.userId
      ? (
          await this.db.workspaceMembership.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
            select: { role: true },
          })
        )?.role
      : null;
  }

  /**
   * The artifact's versions, newest first, `limit` (at most 50) at a time: `before` is the
   * previous page's `nextBefore`, and a null `nextBefore` is the last page.
   */
  async history(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    limit?: number;
    before?: number;
  }) {
    const artifact = await this.artifact(input.workspaceId, input.artifactId, input.reader);
    const whole = (value: number | undefined) => value === undefined || Number.isSafeInteger(value);
    if (!whole(input.limit) || !whole(input.before))
      throw new AppError("INVALID_INPUT", { errorId: "artifact-history-page" });
    const limit = Math.min(Math.max(1, input.limit ?? HISTORY_PAGE), HISTORY_PAGE);
    const rows = await this.db.artifactVersion.findMany({
      where: {
        artifactId: artifact.id,
        ...(input.before !== undefined && { number: { lt: input.before } }),
      },
      orderBy: { number: "desc" },
      take: limit + 1,
      select: {
        number: true,
        publisherUserId: true,
        publisherAgentId: true,
        note: true,
        label: true,
        title: true,
        merged: true,
        revertedFrom: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, limit);
    return {
      versions: page.map(({ publisherUserId, publisherAgentId, ...version }) => ({
        ...version,
        publisher: publisherAgentId
          ? { agentId: publisherAgentId }
          : publisherUserId
            ? { userId: publisherUserId }
            : null,
      })),
      nextBefore: rows.length > limit ? page.at(-1)!.number : null,
    };
  }
}
