SET lock_timeout = '5s';

CREATE TABLE "artifact_public_links" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    CONSTRAINT "artifact_public_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "artifact_public_links_token_key" ON "artifact_public_links"("token");
CREATE UNIQUE INDEX "artifact_public_links_live_key" ON "artifact_public_links"("artifactId") WHERE "revokedAt" IS NULL;
CREATE INDEX "artifact_public_links_artifactId_revokedAt_idx" ON "artifact_public_links"("artifactId", "revokedAt");
ALTER TABLE "artifact_public_links" ADD CONSTRAINT "artifact_public_links_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

RESET lock_timeout;
