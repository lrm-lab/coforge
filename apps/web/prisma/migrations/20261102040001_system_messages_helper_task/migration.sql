SET lock_timeout = '5s';

-- One historical notice's task, with the id resolved by its number in the Workspace.
CREATE OR REPLACE FUNCTION public.coforge_sys_task(workspace uuid, number int, title text)
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'taskId', (
      SELECT t.id FROM tasks t WHERE t."workspaceId" = workspace AND t.number = number LIMIT 1
    ),
    'number', number,
    'title', title
  );
$$ LANGUAGE sql STABLE;

RESET lock_timeout;
