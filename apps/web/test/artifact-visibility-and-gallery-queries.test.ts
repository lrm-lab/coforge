import { describe, expect, test } from "bun:test";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  artifactActivityPageSql,
  doneArtifactsSql,
  readArtifactsSql,
} from "#src/server/artifacts/artifact-activity.server";
import { ArtifactGallery } from "#src/server/artifacts/artifact-gallery.server";
import type { ArtifactReads } from "#src/server/artifacts/artifact-reads.server";
import {
  agentReadableArtifactSql,
  visibleToMemberSql,
  visibleToReaderSql,
} from "#src/server/artifacts/artifact-visible.server";

const WORKSPACE_ID = "019b0381-1111-7111-8111-111111111111";
const USER_ID = "019b0381-2222-7222-8222-222222222222";
const AGENT_ID = "019b0381-3333-7333-8333-333333333333";
const ARTIFACT_ID = "019b0381-4444-7444-8444-444444444444";

describe("artifact visibility, activity, and gallery query efficiency", () => {
  test("readableSql uses a sargable conversations PK lookup instead of concatenating home.id", () => {
    for (const sql of [
      visibleToMemberSql(WORKSPACE_ID, USER_ID),
      visibleToReaderSql({
        workspaceId: WORKSPACE_ID,
        reader: { userId: USER_ID },
        viewer: { member: true, role: "member" },
      }),
      agentReadableArtifactSql(WORKSPACE_ID, AGENT_ID),
    ]) {
      expect(sql.sql).not.toContain(`'conversation:' || home."id"::text`);
      expect(sql.sql).toContain(`home."id" =`);
      expect(sql.sql).toContain(`substring(a."homeKey" FROM 14)::uuid`);
    }
  });

  test("artifactActivityPageSql avoids duplicate eventAfterSql and mentionAfterSql subqueries", () => {
    const sql = artifactActivityPageSql(WORKSPACE_ID, USER_ID, {
      filter: "all",
      limit: 30,
    }).sql;

    const commentScans = sql.match(/FROM "artifact_comments"/g) ?? [];
    const versionScans = sql.match(/FROM "artifact_versions"/g) ?? [];
    const mentionScans = sql.match(/FROM "artifact_comment_mentions"/g) ?? [];

    expect(commentScans.length).toBe(2);
    expect(versionScans.length).toBe(1);
    expect(mentionScans.length).toBe(1);
  });

  test("readArtifactsSql and doneArtifactsSql scope follows CTE when artifactId is provided", () => {
    const mark = { through: new Date("2026-01-01T00:00:00.000Z"), artifactId: ARTIFACT_ID };
    for (const sql of [
      readArtifactsSql(WORKSPACE_ID, USER_ID, mark).sql,
      doneArtifactsSql(WORKSPACE_ID, USER_ID, mark).sql,
    ]) {
      const followsBody = sql.slice(
        sql.indexOf("WITH follows AS MATERIALIZED"),
        sql.indexOf("target AS"),
      );
      expect(followsBody).toContain(`AND a."id" IN (`);
    }
  });

  test("ArtifactGallery.page omits viewer position findMany and skips unused viewer_positions join on updated sort", async () => {
    let viewerPosFindManyCalls = 0;
    const rawSqls: string[] = [];
    const openedAt = new Date("2026-01-02T00:00:00.000Z");
    const updatedAt = new Date("2026-01-03T00:00:00.000Z");

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ role: "member" }),
      },
      artifactViewerPosition: {
        findMany: async () => {
          viewerPosFindManyCalls += 1;
          return [];
        },
      },
      artifact: {
        findMany: async () => [
          {
            id: ARTIFACT_ID,
            title: "Doc",
            entryPath: "index.md",
            homeKey: "workspace",
            access: "workspace",
            currentVersion: 3,
            preview: "hi",
            authorAgentId: AGENT_ID,
            updatedAt,
          },
        ],
      },
      artifactComment: {
        groupBy: async () => [{ artifactId: ARTIFACT_ID, _count: { _all: 4 } }],
      },
      $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
        const text = Prisma.sql(query, ...values).sql;
        rawSqls.push(text);
        if (text.includes(`FROM "artifacts" a`)) {
          return [{ id: ARTIFACT_ID, key: updatedAt, updatedAt }];
        }
        return [
          {
            artifactId: ARTIFACT_ID,
            openedAt,
            seenVersion: 2,
            newComments: 1,
            mentioned: true,
          },
        ];
      },
    } as unknown as PrismaClient;

    const gallery = new ArtifactGallery(db, { cards: async () => [] } as unknown as Pick<
      ArtifactReads,
      "cards"
    >);
    const page = await gallery.page({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sort: "updated",
      limit: 20,
    });

    expect(viewerPosFindManyCalls).toBe(0);
    expect(rawSqls[0]).not.toContain(`"artifact_viewer_positions"`);
    expect(page.artifacts).toHaveLength(1);
    expect(page.artifacts[0]).toMatchObject({
      id: ARTIFACT_ID,
      openedAt,
      commentCount: 4,
      hasUpdates: true,
      newComments: 1,
      mentionsYou: true,
    });

    rawSqls.length = 0;
    await gallery.page({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sort: "opened",
      limit: 20,
    });
    expect(rawSqls[0]).toContain(`"artifact_viewer_positions"`);
  });

  test("ArtifactGallery.marks reuses reads.cards without re-fetching artifacts or artifactViewerPosition", async () => {
    let artifactFindManyCalls = 0;
    let viewerPosFindManyCalls = 0;
    const openedAt = new Date("2026-01-02T00:00:00.000Z");

    const db = {
      artifact: {
        findMany: async () => {
          artifactFindManyCalls += 1;
          return [];
        },
      },
      artifactViewerPosition: {
        findMany: async () => {
          viewerPosFindManyCalls += 1;
          return [];
        },
      },
      artifactComment: {
        groupBy: async () => [{ artifactId: ARTIFACT_ID, _count: { _all: 2 } }],
      },
      $queryRaw: async () => [
        {
          artifactId: ARTIFACT_ID,
          openedAt,
          seenVersion: 1,
          newComments: 1,
          mentioned: false,
        },
      ],
    } as unknown as PrismaClient;

    const reads = {
      cards: async () => [
        {
          id: ARTIFACT_ID,
          access: "link" as const,
          currentVersion: 2,
        },
      ],
    } as unknown as Pick<ArtifactReads, "cards">;

    const marks = await new ArtifactGallery(db, reads).marks({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      artifactIds: [ARTIFACT_ID],
    });

    expect(artifactFindManyCalls).toBe(0);
    expect(viewerPosFindManyCalls).toBe(0);
    expect(marks).toEqual([
      {
        id: ARTIFACT_ID,
        link: true,
        openedAt,
        commentCount: 2,
        hasUpdates: true,
        newComments: 1,
        mentionsYou: false,
      },
    ]);
  });
});
