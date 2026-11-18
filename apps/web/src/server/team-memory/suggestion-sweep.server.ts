import { getDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { scanTeamMemorySuggestions, TEAM_MEMORY_SCAN_INTERVAL_MS } from "./suggestion-scan.server";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

export function ensureTeamMemorySuggestionSweep() {
  if (timer || Bun.env.COFORGE_TEAM_MEMORY_REVIEW !== "true") return;
  timer = setInterval(
    () =>
      void sweep().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "team_memory.review_sweep_failed",
            error_type: error instanceof Error ? error.name : "unknown",
          }),
        );
      }),
    15 * 60_000,
  );
  onServerShutdown(() => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}

async function sweep() {
  if (ticking) return;
  const db = getDatabaseClient();
  if (!db) return;
  ticking = true;
  try {
    const cutoff = new Date(Date.now() - TEAM_MEMORY_SCAN_INTERVAL_MS);
    const workspaces = await db.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM workspaces w
      LEFT JOIN team_memory_review_scans s ON s.workspace_id = w.id
      WHERE (s.scanned_at IS NULL OR s.scanned_at <= ${cutoff})
        AND COALESCE(NULLIF(w.experiments->'teamMemory', 'null'::jsonb), 'true'::jsonb) = 'true'::jsonb
        AND EXISTS (
          SELECT 1 FROM team_memory_entries m
          WHERE m.workspace_id = w.id AND m.status = 'active' AND NOT m.pinned
        )
      ORDER BY s.scanned_at ASC NULLS FIRST, w.id ASC LIMIT 8`;
    await Promise.allSettled(
      workspaces.map(async ({ id }) => {
        try {
          const result = await scanTeamMemorySuggestions(db, id);
          console.info(
            JSON.stringify({ event: "team_memory.review_scanned", workspace_id: id, ...result }),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "team_memory.review_scan_failed",
              workspace_id: id,
              error_type: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }),
    );
  } finally {
    ticking = false;
  }
}
