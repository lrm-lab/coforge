-- migration-safety v1
-- checked: 2026-11-17T01:30:56.515Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-17T00:13:17.583Z production
-- body-sha256: 70cb11f27c955c14b0579d44cd25e099c795ea7b5b8e2a62c3688924ff4aef1e
-- table: "artifact_follows" rows≈-1 size=24576 lock=row-exclusive rewrite=yes statement=UPDATE without WHERE
UPDATE "artifact_follows" SET "followedAt" = "createdAt";
