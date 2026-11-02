-- migration-safety v1
-- checked: 2026-11-02T03:24:20.272Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: ad293883c2fddce7caacfe4a15402801e7d3357aa7e67c5dee8fc7880279ca76
-- table: "*" rows≈-1 size=0 lock=access-exclusive rewrite=yes statement=unrecognised statement
SET lock_timeout = '5s';

-- Backfill the structured kind of every existing system message (`senderMemberId IS NULL`).
-- Historical rows keep their rendered English body as `params.body`; the web shows it as-is when
-- the structured fields are absent. New notices never store their body in `params`.
-- A classification that cannot explain more than 50 rows or 1% of them aborts the whole
-- migration, so a new historical format is noticed at deploy time instead of being guessed.
DO $$
DECLARE
  total bigint;
  unclassified bigint;
  sample text;
BEGIN
  SELECT count(*) INTO total FROM messages WHERE "senderMemberId" IS NULL;

  CREATE TEMP TABLE _sys_backfill ON COMMIT DROP AS
  SELECT
    m.id AS "messageId",
    m."conversationId",
    m."workspaceId",
    m.body,
    CASE
      WHEN m.body ~ '^📋 [0-9]+ new tasks? created: ' THEN 'task.created'
      WHEN m.body ~ '^📋 .+ converted a message to task #[0-9]+' THEN 'task.converted'
      WHEN m.body ~ '^📋 .+ made task #[0-9]+ .*from this message' THEN 'task.from_message'
      WHEN m.body ~ '^📌 .+ assigned #[0-9]+ .+ to @' THEN 'task.assigned'
      WHEN m.body ~ '^📌 Assigned @[^ ]+ to tasks? #[0-9]+' THEN 'task.assigned'
      WHEN m.body ~ '^📌 .+ claimed #[0-9]+' THEN 'task.claimed'
      WHEN m.body ~ '^.+ moved #[0-9]+ .+ to (Todo|In Progress|In Review|Done|Closed)$' THEN 'task.moved'
      WHEN m.body ~ '^🔓 .+ unassigned #[0-9]+' THEN 'task.unassigned'
      WHEN m.body ~ '^@?[^ ]+ assigned you task #[0-9]+: ' THEN 'task.assigned_you'
      WHEN m.body ~ '^.+ stopped following this task' THEN 'task.unfollowed'
      WHEN m.body ~ '^.+ (made @[^ ]+ the coordinator of #|removed @[^ ]+ as coordinator of #)' THEN 'channel.coordinator_changed'
      WHEN m.body ~ '^\[CoForge coordinator change\] #' THEN 'channel.coordinator_changed'
      WHEN m.body ~ '^\[CoForge paused\] These Agents have exchanged' THEN 'agent_dm.chain_limit'
      WHEN m.body ~ '^\[CoForge paused\] An Agent here has sent' THEN 'agent_dm.rate_limit'
      ELSE 'unclassified'
    END AS kind
  FROM messages m
  WHERE m."senderMemberId" IS NULL;

  SELECT count(*) INTO unclassified FROM _sys_backfill WHERE kind = 'unclassified';
  SELECT string_agg(left(body, 160), E'\n') INTO sample
  FROM (SELECT body FROM _sys_backfill WHERE kind = 'unclassified' LIMIT 5) examples;
  RAISE NOTICE 'system_messages backfill: total=%, unclassified=%, samples=%',
    total, unclassified, coalesce(sample, '');

  IF unclassified > 50 OR (total > 0 AND unclassified::numeric / total > 0.01) THEN
    RAISE EXCEPTION 'system_messages backfill refused: % of % system messages unclassified',
      unclassified, total;
  END IF;

  INSERT INTO system_messages ("messageId", "conversationId", "workspaceId", kind, params)
  SELECT "messageId", "conversationId", "workspaceId",
    CASE WHEN kind = 'unclassified' THEN 'legacy_text' ELSE kind END,
    jsonb_build_object('body', body)
  FROM _sys_backfill
  ON CONFLICT ("messageId") DO NOTHING;

  SELECT count(*) INTO unclassified
  FROM messages m
  LEFT JOIN system_messages s ON s."messageId" = m.id
  WHERE m."senderMemberId" IS NULL AND s."messageId" IS NULL;
  IF unclassified > 0 THEN
    RAISE EXCEPTION 'system_messages backfill left % system messages without a row', unclassified;
  END IF;
END $$;

RESET lock_timeout;
