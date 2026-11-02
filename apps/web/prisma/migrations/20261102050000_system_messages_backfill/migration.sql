-- migration-safety v1
-- checked: 2026-11-02T03:58:24.489Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: 2bf31d95a34e8236b8ef995dc87ac72a4e2df2e48c04522b3f6f51d436c38611
-- table: "*" rows≈-1 size=0 lock=access-exclusive rewrite=yes statement=unrecognised statement
SET lock_timeout = '5s';

-- Backfill the structured kind and full parameters of every existing system message
-- (`senderMemberId IS NULL`). Historical rows parse into the same params new notices write, so
-- the web has one rendering path; only a row that cannot be parsed becomes `legacy_text`.
-- A person's member id is left null for historical rows: the body carries the name, and a
-- profile link needs a current member row. A task id is resolved by its number. More than 50
-- unparseable rows, or more than 1%, aborts the whole migration.
DO $$
DECLARE
  total bigint;
  unparseable bigint;
  sample text;
BEGIN
  SELECT count(*) INTO total FROM messages WHERE "senderMemberId" IS NULL;

  CREATE TEMP TABLE _sys_backfill ON COMMIT DROP AS
  SELECT
    m.id AS "messageId",
    m."conversationId",
    m."workspaceId",
    m."threadRootId",
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

  SELECT count(*) INTO unparseable FROM _sys_backfill WHERE kind = 'unclassified';
  SELECT string_agg(left(body, 160), E'\n') INTO sample
  FROM (SELECT body FROM _sys_backfill WHERE kind = 'unclassified' LIMIT 5) examples;
  RAISE NOTICE 'system_messages backfill: total=%, unparseable=%, samples=%',
    total, unparseable, coalesce(sample, '');

  IF unparseable > 50 OR (total > 0 AND unparseable::numeric / total > 0.01) THEN
    RAISE EXCEPTION 'system_messages backfill refused: % of % system messages unparseable',
      unparseable, total;
  END IF;

  INSERT INTO system_messages ("messageId", "conversationId", "workspaceId", kind, params)
  SELECT b."messageId", b."conversationId", b."workspaceId",
    CASE WHEN b.kind = 'unclassified' THEN 'legacy_text' ELSE b.kind END,
    CASE b.kind
      WHEN 'task.created' THEN jsonb_build_object('tasks', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = x[1]::int LIMIT 1), 'number', x[1]::int, 'title', x[2])), '[]'::jsonb)
        FROM regexp_matches(substring(b.body from 'created: (.*)$'), '#([0-9]+) "([^"]*)"', 'g') AS x
      ))
      WHEN 'task.converted' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^📋 (.+?) converted a message'))[1], '')),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'converted a message to task #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'converted a message to task #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'converted a message to task #[0-9]+ "([^"]*)"'))[1], '')))
      WHEN 'task.from_message' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^📋 (.+?) made task'))[1], '')),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'made task #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'made task #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'made task #[0-9]+ "([^"]*)"'))[1], '')))
      WHEN 'task.assigned' THEN
        CASE WHEN b.body ~ '^📌 Assigned @' THEN jsonb_build_object(
            'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', ''),
            'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'Assigned @[^ ]+ to tasks? #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'Assigned @[^ ]+ to tasks? #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'Assigned @[^ ]+ to tasks? #[0-9]+ "([^"]*)"'))[1], '')),
            'assignee', jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, 'Assigned @([^ ]+) to tasks?'))[1], ''), 'displayName', ''))
          ELSE jsonb_build_object(
            'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^📌 (.+?) assigned #'))[1], '')),
            'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'assigned #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'assigned #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'assigned #[0-9]+ "([^"]*)"'))[1], '')),
            'assignee', jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, ' to @([^ ]+)$'))[1], ''), 'displayName', '')) END
      WHEN 'task.claimed' THEN jsonb_build_object(
        'claimer', jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, '^📌 ([^ ]+) claimed #'))[1], ''), 'displayName', ''),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'claimed #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'claimed #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'claimed #[0-9]+ "([^"]*)"'))[1], '')))
      WHEN 'task.moved' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^(.+?) moved #'))[1], '')),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'moved #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'moved #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'moved #[0-9]+ "([^"]*)"'))[1], '')),
        'status', CASE coalesce((regexp_match(b.body, 'to (Todo|In Progress|In Review|Done|Closed)$'))[1], '')
          WHEN 'Todo' THEN 'todo'
          WHEN 'In Progress' THEN 'in_progress'
          WHEN 'In Review' THEN 'in_review'
          WHEN 'Done' THEN 'done'
          WHEN 'Closed' THEN 'closed'
          ELSE 'todo'
        END)
      WHEN 'task.unassigned' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^🔓 (.+?) unassigned #'))[1], '')),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'unassigned #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'unassigned #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'unassigned #[0-9]+ "([^"]*)"'))[1], '')))
      WHEN 'task.assigned_you' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, '^@?([^ ]+) assigned you task #'))[1], ''), 'displayName', ''),
        'task', jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = coalesce((regexp_match(b.body, 'assigned you task #([0-9]+)'))[1]::int, 0) LIMIT 1), 'number', coalesce((regexp_match(b.body, 'assigned you task #([0-9]+)'))[1]::int, 0), 'title', coalesce((regexp_match(b.body, 'assigned you task #[0-9]+: (.*)$'))[1], '')))
      WHEN 'task.unfollowed' THEN jsonb_build_object(
        'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^(.+?) stopped following'))[1], '')),
        'task', coalesce((
          SELECT jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = t.number LIMIT 1), 'number', t.number, 'title', t.title)
          FROM tasks t WHERE t."messageId" = b."threadRootId" LIMIT 1
        ), jsonb_build_object('taskId', (SELECT t.id FROM tasks t WHERE t."workspaceId" = b."workspaceId" AND t.number = 0 LIMIT 1), 'number', 0, 'title', '')),
        'reason', nullif(coalesce((regexp_match(b.body, 'stopped following this task: (.*)$'))[1], ''), ''))
      WHEN 'channel.coordinator_changed' THEN
        CASE WHEN b.body ~ '^\[CoForge coordinator change\]' THEN jsonb_build_object(
            'channelId', (
              SELECT c.id FROM conversations c
              WHERE c."workspaceId" = b."workspaceId"
                AND c."channelName" = coalesce((regexp_match(b.body, '^\[CoForge coordinator change\] #([^:]+):'))[1], '')
              LIMIT 1
            ),
            'channelName', coalesce((regexp_match(b.body, '^\[CoForge coordinator change\] #([^:]+):'))[1], ''),
            'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', ''),
            'next', jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, 'coordinator=@?([^ ]+)$'))[1], ''), 'displayName', ''))
          ELSE jsonb_build_object(
            'channelId', (
              SELECT c.id FROM conversations c
              WHERE c."workspaceId" = b."workspaceId"
                AND c."channelName" = coalesce((regexp_match(b.body, ' of #([^ ]+)$'))[1], '')
              LIMIT 1
            ),
            'channelName', coalesce((regexp_match(b.body, ' of #([^ ]+)$'))[1], ''),
            'actor', jsonb_build_object('memberId', NULL, 'handle', '', 'displayName', coalesce((regexp_match(b.body, '^(.+?) (?:made @|removed @)'))[1], '')),
            'next', CASE WHEN b.body ~ ' made @'
              THEN jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, 'made @([^ ]+) the coordinator'))[1], ''), 'displayName', '')
              ELSE NULL END,
            'previous', CASE WHEN b.body ~ 'removed @'
              THEN jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, 'removed @([^ ]+) as coordinator'))[1], ''), 'displayName', '')
              WHEN b.body ~ 'replacing @'
              THEN jsonb_build_object('memberId', NULL, 'handle', coalesce((regexp_match(b.body, 'replacing @([^)]+)'))[1], ''), 'displayName', '')
              ELSE NULL END) END
      WHEN 'agent_dm.chain_limit' THEN '{}'::jsonb
      WHEN 'agent_dm.rate_limit' THEN '{}'::jsonb
      ELSE jsonb_build_object('body', b.body)
    END
  FROM _sys_backfill b
  ON CONFLICT ("messageId") DO NOTHING;

  SELECT count(*) INTO unparseable
  FROM messages m
  LEFT JOIN system_messages s ON s."messageId" = m.id
  WHERE m."senderMemberId" IS NULL AND s."messageId" IS NULL;
  IF unparseable > 0 THEN
    RAISE EXCEPTION 'system_messages backfill left % system messages without a row', unparseable;
  END IF;
END $$;

RESET lock_timeout;
