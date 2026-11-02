-- migration-safety v1
-- checked: 2026-11-02T05:14:59.263Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: 99efa9695ccd5f3d27468ef916bfbc8665041deaf0f859010ef66954f6c3c5e0
-- table: "*" rows≈-1 size=0 lock=access-exclusive rewrite=yes statement=unrecognised statement
SET lock_timeout = '5s';

-- Fill the full parameters of the rows the earlier backfill stored with only `params.body`.
-- That migration stays as it ran; this one upgrades its rows in place, so staging (which already
-- applied the earlier form) and production (which runs both) end in the same state.
DO $$
DECLARE
  total bigint;
  unparseable bigint;
  sample text;
BEGIN
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.coforge_sys_person(p_conversation uuid, p_handle text, p_display_name text)
    RETURNS jsonb AS $body$
      SELECT jsonb_build_object(
        'memberId', (
          SELECT CASE WHEN count(*) = 1 THEN (array_agg(cm.id))[1] ELSE NULL END
          FROM conversation_members cm
          LEFT JOIN users u ON u.id = cm."userId"
          LEFT JOIN agents a ON a.id = cm."agentId"
          WHERE cm."conversationId" = p_conversation
            AND ((p_handle <> '' AND (u.username = p_handle OR a.name = p_handle))
              OR (p_handle = '' AND p_display_name <> '' AND (u."displayName" = p_display_name OR a."displayName" = p_display_name)))
        ),
        'handle', p_handle, 'displayName', p_display_name);
    $body$ LANGUAGE sql STABLE;
  $fn$;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.coforge_sys_task(p_conversation uuid, p_number int, p_title text)
    RETURNS jsonb AS $body$
      SELECT jsonb_build_object(
        'taskId', (SELECT t.id FROM tasks t WHERE t."conversationId" = p_conversation AND t.number = p_number LIMIT 1),
        'number', p_number, 'title', p_title);
    $body$ LANGUAGE sql STABLE;
  $fn$;
  SELECT count(*) INTO total
  FROM system_messages s JOIN messages m ON m.id = s."messageId"
  WHERE s.params ? 'body' AND s.kind <> 'legacy_text';

  CREATE TEMP TABLE _sys_params ON COMMIT DROP AS
  SELECT
    s."messageId", s."conversationId", s."workspaceId", m."threadRootId", m.body, s.kind,
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
    END AS parsed_kind
  FROM system_messages s JOIN messages m ON m.id = s."messageId"
  WHERE s.params ? 'body' AND s.kind <> 'legacy_text';

  SELECT count(*) INTO unparseable FROM _sys_params WHERE parsed_kind <> kind;
  SELECT string_agg(left(body, 160), E'\n') INTO sample
  FROM (SELECT body FROM _sys_params WHERE parsed_kind <> kind LIMIT 5) examples;
  RAISE NOTICE 'system_messages params: total=%, unparseable=%, samples=%',
    total, unparseable, coalesce(sample, '');

  IF unparseable > 50 OR (total > 0 AND unparseable::numeric / total > 0.01) THEN
    RAISE EXCEPTION 'system_messages params refused: % of % rows unparseable', unparseable, total;
  END IF;

  UPDATE system_messages s
  SET kind = CASE WHEN b.parsed_kind <> b.kind THEN 'legacy_text' ELSE b.kind END,
      params = CASE WHEN b.parsed_kind <> b.kind THEN jsonb_build_object('body', b.body)
        ELSE CASE b.kind
          WHEN 'task.created' THEN jsonb_build_object('tasks', (
        SELECT coalesce(jsonb_agg(public.coforge_sys_task(b."conversationId", x[1]::int, x[2])), '[]'::jsonb)
        FROM regexp_matches(substring(b.body from 'created: (.*)$'), '#([0-9]+) "([^"]*)"', 'g') AS x
      ))
          WHEN 'task.converted' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^📋 (.+?) converted a message'))[1], '')), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'converted a message to task #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'converted a message to task #[0-9]+ "([^"]*)"'))[1], '')))
          WHEN 'task.from_message' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^📋 (.+?) made task'))[1], '')), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'made task #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'made task #[0-9]+ "([^"]*)"'))[1], '')))
          WHEN 'task.assigned' THEN CASE WHEN b.body ~ '^📌 Assigned @' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', ''), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'Assigned @[^ ]+ to tasks? #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'Assigned @[^ ]+ to tasks? #[0-9]+ "([^"]*)"'))[1], '')), 'assignee', public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, 'Assigned @([^ ]+) to tasks?'))[1], ''), '')) ELSE jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^📌 (.+?) assigned #'))[1], '')), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'assigned #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'assigned #[0-9]+ "([^"]*)"'))[1], '')), 'assignee', public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, ' to @([^ ]+)$'))[1], ''), '')) END
          WHEN 'task.claimed' THEN jsonb_build_object('claimer', public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, '^📌 ([^ ]+) claimed #'))[1], ''), ''), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'claimed #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'claimed #[0-9]+ "([^"]*)"'))[1], '')))
          WHEN 'task.moved' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^(.+?) moved #'))[1], '')), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'moved #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'moved #[0-9]+ "([^"]*)"'))[1], '')), 'status', CASE coalesce((regexp_match(b.body, 'to (Todo|In Progress|In Review|Done|Closed)$'))[1], '') WHEN 'Todo' THEN 'todo' WHEN 'In Progress' THEN 'in_progress' WHEN 'In Review' THEN 'in_review' WHEN 'Done' THEN 'done' WHEN 'Closed' THEN 'closed' ELSE 'todo' END)
          WHEN 'task.unassigned' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^🔓 (.+?) unassigned #'))[1], '')), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'unassigned #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'unassigned #[0-9]+ "([^"]*)"'))[1], '')))
          WHEN 'task.assigned_you' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, '^@?([^ ]+) assigned you task #'))[1], ''), ''), 'task', public.coforge_sys_task(b."conversationId", coalesce((regexp_match(b.body, 'assigned you task #([0-9]+)'))[1]::int, 0), coalesce((regexp_match(b.body, 'assigned you task #[0-9]+: (.*)$'))[1], '')))
          WHEN 'task.unfollowed' THEN jsonb_build_object('actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^(.+?) stopped following'))[1], '')), 'task', coalesce((SELECT jsonb_build_object('taskId', t.id, 'number', t.number, 'title', t.title) FROM tasks t WHERE t."messageId" = b."threadRootId" LIMIT 1), jsonb_build_object('taskId', NULL, 'number', 0, 'title', '')), 'reason', nullif(coalesce((regexp_match(b.body, 'stopped following this task: (.*)$'))[1], ''), ''))
          WHEN 'channel.coordinator_changed' THEN CASE WHEN b.body ~ '^\[CoForge coordinator change\]' THEN jsonb_build_object('channelId', (SELECT c.id FROM conversations c WHERE c."workspaceId" = b."workspaceId" AND c."channelName" = coalesce((regexp_match(b.body, '^\[CoForge coordinator change\] #([^:]+):'))[1], '') LIMIT 1), 'channelName', coalesce((regexp_match(b.body, '^\[CoForge coordinator change\] #([^:]+):'))[1], ''), 'actor', public.coforge_sys_person(b."conversationId", '', ''), 'next', public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, 'coordinator=@?([^ ]+)$'))[1], ''), '')) ELSE jsonb_build_object('channelId', (SELECT c.id FROM conversations c WHERE c."workspaceId" = b."workspaceId" AND c."channelName" = coalesce((regexp_match(b.body, ' of #([^ ]+)$'))[1], '') LIMIT 1), 'channelName', coalesce((regexp_match(b.body, ' of #([^ ]+)$'))[1], ''), 'actor', public.coforge_sys_person(b."conversationId", '', coalesce((regexp_match(b.body, '^(.+?) (?:made @|removed @)'))[1], '')), 'next', CASE WHEN b.body ~ ' made @' THEN public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, 'made @([^ ]+) the coordinator'))[1], ''), '') ELSE NULL END, 'previous', CASE WHEN b.body ~ 'removed @' THEN public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, 'removed @([^ ]+) as coordinator'))[1], ''), '') WHEN b.body ~ 'replacing @' THEN public.coforge_sys_person(b."conversationId", coalesce((regexp_match(b.body, 'replacing @([^)]+)'))[1], ''), '') ELSE NULL END) END
          WHEN 'agent_dm.chain_limit' THEN '{}'::jsonb
          WHEN 'agent_dm.rate_limit' THEN '{}'::jsonb
          ELSE jsonb_build_object('body', b.body)
        END END
  FROM _sys_params b
  WHERE s."messageId" = b."messageId";

  EXECUTE 'DROP FUNCTION IF EXISTS public.coforge_sys_person(uuid, text, text), public.coforge_sys_task(uuid, int, text)';
END $$;

RESET lock_timeout;
