-- An extra cloud Computer belongs to one Workspace. Each account keeps one live extra there.

ALTER TABLE "computers" ADD COLUMN "homeWorkspaceId" UUID;

UPDATE "computers" AS computer
SET "homeWorkspaceId" = linked."workspaceId"
FROM (
    SELECT DISTINCT ON (link."computerId") link."computerId", link."workspaceId"
    FROM "workspace_computers" AS link
    INNER JOIN "computers" AS extra
        ON extra."id" = link."computerId"
    WHERE extra."kind" = 'cloud'
        AND extra."cloudSlot" = 'extra'
    ORDER BY link."computerId", link."createdAt"
) AS linked
WHERE computer."id" = linked."computerId";

DROP INDEX "computers_one_live_cloud_extra";

CREATE UNIQUE INDEX "computers_one_live_cloud_extra_per_workspace"
    ON "computers"("ownerId", "homeWorkspaceId")
    WHERE (
        "kind" = 'cloud'
        AND "cloudSlot" = 'extra'
        AND "deletedAt" IS NULL
        AND "homeWorkspaceId" IS NOT NULL
    );
