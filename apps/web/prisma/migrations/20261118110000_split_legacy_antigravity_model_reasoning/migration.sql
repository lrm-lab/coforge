-- migration-safety v1
-- checked: 2026-11-18T03:17:27.805Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-18T01:04:18.010Z production
-- body-sha256: 7d053e0467a7357c626e873b6c4d44241cbfdb58a941965899f30aff7be1fa94
-- table: "agents" rows≈130 size=417792 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';
-- Rollback: UPDATE "agents" SET "runtimeConfig" = "runtimeConfig" || jsonb_build_object('model', ("runtimeConfig"->>'model') || '-' || ("runtimeConfig"->>'reasoning'), 'reasoning', ''), "runtimeConfigRevision" = GREATEST("runtimeConfigRevision" - 1, 0) WHERE "runtimeConfig"->>'provider' = 'antigravity' AND ("runtimeConfig"->>'model', "runtimeConfig"->>'reasoning') IN (('gemini-3.8-flash', 'high'), ('gemini-3.8-flash', 'medium'), ('gemini-3.8-flash', 'low'), ('gemini-3.7-flash', 'high'), ('gemini-3.7-flash', 'medium'), ('gemini-3.7-flash', 'low'), ('gemini-3.6-flash', 'high'), ('gemini-3.6-flash', 'medium'), ('gemini-3.6-flash', 'low'), ('gemini-3.1-pro', 'high'), ('gemini-3.1-pro', 'low'));
UPDATE "agents"
SET
  "runtimeConfig" = "runtimeConfig" || jsonb_build_object(
    'model',
    CASE "runtimeConfig"->>'model'
      WHEN 'gemini-3.8-flash-high' THEN 'gemini-3.8-flash'
      WHEN 'gemini-3.8-flash-medium' THEN 'gemini-3.8-flash'
      WHEN 'gemini-3.8-flash-low' THEN 'gemini-3.8-flash'
      WHEN 'gemini-3.7-flash-high' THEN 'gemini-3.7-flash'
      WHEN 'gemini-3.7-flash-medium' THEN 'gemini-3.7-flash'
      WHEN 'gemini-3.7-flash-low' THEN 'gemini-3.7-flash'
      WHEN 'gemini-3.6-flash-high' THEN 'gemini-3.6-flash'
      WHEN 'gemini-3.6-flash-medium' THEN 'gemini-3.6-flash'
      WHEN 'gemini-3.6-flash-low' THEN 'gemini-3.6-flash'
      WHEN 'gemini-3.1-pro-high' THEN 'gemini-3.1-pro'
      WHEN 'gemini-3.1-pro-low' THEN 'gemini-3.1-pro'
    END,
    'reasoning',
    CASE
      WHEN "runtimeConfig"->>'model' LIKE '%-high' THEN 'high'
      WHEN "runtimeConfig"->>'model' LIKE '%-medium' THEN 'medium'
      WHEN "runtimeConfig"->>'model' LIKE '%-low' THEN 'low'
    END
  ),
  "runtimeConfigRevision" = "runtimeConfigRevision" + 1
WHERE "runtimeConfig"->>'provider' = 'antigravity'
  AND COALESCE("runtimeConfig"->>'reasoning', '') = ''
  AND "runtimeConfig"->>'model' IN (
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-low',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low'
  );
RESET lock_timeout;
