ALTER TABLE "conversations" ADD COLUMN "lastSequence" INTEGER NOT NULL DEFAULT 0;
UPDATE "conversations" AS c
SET "lastSequence" = COALESCE(
  (SELECT MAX(m."sequence") FROM "messages" AS m WHERE m."conversationId" = c."id"),
  0
);
