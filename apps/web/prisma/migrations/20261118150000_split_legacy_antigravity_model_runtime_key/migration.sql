-- migration-safety v1
-- checked: 2026-11-18T13:39:58.888Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-16T09:06:15.181Z production
-- body-sha256: 74a8123a1c693dde5956dac7496fc0edb856a9b15e68ead8b3f53a2d3d41d44a
-- table: "agents" rows≈127 size=409600 lock=row-exclusive rewrite=yes statement=UPDATE
-- Rollback: UPDATE "agents" SET "runtimeConfig" = "runtimeConfig" || jsonb_build_object('model', ("runtimeConfig"->>'model') || '-' || ("runtimeConfig"->>'reasoning'), 'reasoning', ''), "runtimeConfigRevision" = GREATEST("runtimeConfigRevision" - 1, 0) WHERE "runtimeConfig"->>'runtime' = 'antigravity' AND ("runtimeConfig"->>'model', "runtimeConfig"->>'reasoning') IN (('gemini-3.8-flash', 'high'), ('gemini-3.8-flash', 'medium'), ('gemini-3.8-flash', 'low'), ('gemini-3.7-flash', 'high'), ('gemini-3.7-flash', 'medium'), ('gemini-3.7-flash', 'low'), ('gemini-3.6-flash', 'high'), ('gemini-3.6-flash', 'medium'), ('gemini-3.6-flash', 'low'), ('gemini-3.1-pro', 'high'), ('gemini-3.1-pro', 'low'));
SET lock_timeout = '5s';
UPDATE "agents" AS "a"
SET
  "runtimeConfig" = "a"."runtimeConfig" || jsonb_build_object(
    'model', "s"."model",
    'reasoning', "s"."reasoning"
  ),
  "runtimeConfigRevision" = "a"."runtimeConfigRevision" + 1
FROM (
  VALUES
    ('gemini-3.8-flash-high', 'gemini-3.8-flash', 'high'),
    ('gemini-3.8-flash-medium', 'gemini-3.8-flash', 'medium'),
    ('gemini-3.8-flash-low', 'gemini-3.8-flash', 'low'),
    ('gemini-3.7-flash-high', 'gemini-3.7-flash', 'high'),
    ('gemini-3.7-flash-medium', 'gemini-3.7-flash', 'medium'),
    ('gemini-3.7-flash-low', 'gemini-3.7-flash', 'low'),
    ('gemini-3.6-flash-high', 'gemini-3.6-flash', 'high'),
    ('gemini-3.6-flash-medium', 'gemini-3.6-flash', 'medium'),
    ('gemini-3.6-flash-low', 'gemini-3.6-flash', 'low'),
    ('gemini-3.1-pro-high', 'gemini-3.1-pro', 'high'),
    ('gemini-3.1-pro-low', 'gemini-3.1-pro', 'low')
) AS "s"("legacy", "model", "reasoning")
WHERE "a"."runtimeConfig"->>'runtime' = 'antigravity'
  AND COALESCE("a"."runtimeConfig"->>'reasoning', '') = ''
  AND "a"."runtimeConfig"->>'model' = "s"."legacy";
RESET lock_timeout;
