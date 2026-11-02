SET lock_timeout = '5s';

-- One historical notice's person, resolved to a conversation member when exactly one active
-- member in the Workspace matches the handle (or, without a handle, the display name).
CREATE OR REPLACE FUNCTION public.coforge_sys_person(workspace uuid, handle text, display_name text)
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'memberId', (
      SELECT cm.id
      FROM conversation_members cm
      LEFT JOIN users u ON u.id = cm."userId"
      LEFT JOIN agents a ON a.id = cm."agentId"
      WHERE cm."workspaceId" = workspace
        AND (
          (handle <> '' AND (u.username = handle OR a.name = handle))
          OR (handle = '' AND display_name <> '' AND (u."displayName" = display_name OR a."displayName" = display_name))
        )
      GROUP BY cm.id
      HAVING count(*) = 1
      LIMIT 1
    ),
    'handle', handle,
    'displayName', display_name
  );
$$ LANGUAGE sql STABLE;

RESET lock_timeout;
