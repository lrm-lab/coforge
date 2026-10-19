-- A new Agent introduces itself to its creator by DM on its first start. `introductionDueAt` is set
-- when a person creates the Agent and cleared once its message reaches the creator's DM; null means
-- no introduction is owed, so no existing Agent greets.

ALTER TABLE "agents" ADD COLUMN "introductionDueAt" TIMESTAMP(3);
