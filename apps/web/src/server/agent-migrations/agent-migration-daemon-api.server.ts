import { z } from "zod";
import type { AgentMigrationRecord, MigrationParticipant } from "./agent-migrations.server";
import type { AgentMigrationDispatch } from "./agent-migration-dispatch.server";
import type { AgentMigrationTransport } from "./agent-migration-transport.server";

/**
 * The one HTTPS operation a Computer's daemon calls, with its daemon API key, while an Agent
 * migration moves its workspace (`/api/daemon/agent-migrations`). Each body names an `operation`;
 * the answer is an HTTP status the daemon can act on and a JSON body. Refusals never read as 200:
 * `404` when the migration is not this Computer's, `422` for a manifest or chunk the writer could
 * not have produced, `503` when the deployment has no migration bucket, and `409` for every
 * state-machine refusal, whose `error` names the code. Only a 409 from the bucket's own PUT means a
 * chunk is already uploaded; a 409 from this route is a refusal to read by its `error`.
 */

const ids = {
  migrationId: z.string().min(1).max(64),
  generation: z.number().int().positive(),
};
const revision = { expectedRevision: z.number().int().min(0) };

export const agentMigrationDaemonRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("view"), migrationId: ids.migrationId }),
  z.object({
    operation: z.literal("step"),
    ...ids,
    ...revision,
    step: z.enum(["source_stopped", "placement_started", "switch", "arrived"]),
  }),
  z.object({ operation: z.literal("upload_url"), ...ids, chunk: z.unknown() }),
  z.object({
    operation: z.literal("download_url"),
    ...ids,
    index: z.number().int().min(0),
  }),
  z.object({ operation: z.literal("upload_complete"), ...ids, ...revision, manifest: z.unknown() }),
  z.object({
    operation: z.literal("fail"),
    ...ids,
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    errorDetail: z.string().max(2000).optional(),
  }),
]);

export type AgentMigrationDaemonRequest = z.infer<typeof agentMigrationDaemonRequestSchema>;

type Answer = { status: number; body: unknown };

const REFUSAL_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_manifest: 422,
  invalid_chunk: 422,
  chunks_missing: 422,
  unavailable: 503,
};

const refused = (code: string): Answer => ({
  status: REFUSAL_STATUS[code] ?? 409,
  body: { error: code },
});

const describe = (migration: AgentMigrationRecord) => ({
  id: migration.id,
  state: migration.state,
  generation: migration.generation,
  revision: migration.revision,
  errorCode: migration.errorCode,
});

function answer(
  result:
    | { status: "refused"; code: string }
    | { status: "advanced" | "already_applied" | "failed"; migration: AgentMigrationRecord },
): Answer {
  return result.status === "refused"
    ? refused(result.code)
    : { status: 200, body: { status: result.status, migration: describe(result.migration) } };
}

export async function answerAgentMigrationDaemonRequest(
  transport: AgentMigrationTransport,
  dispatch: AgentMigrationDispatch,
  participant: MigrationParticipant,
  input: AgentMigrationDaemonRequest,
): Promise<Answer> {
  switch (input.operation) {
    case "view": {
      const view = await transport.view(participant, input.migrationId);
      return view ? { status: 200, body: view } : refused("not_found");
    }
    case "step":
      return answer(await transport.step(participant, input));
    case "upload_url": {
      const issued = await transport.uploadUrl(participant, input);
      return issued.status === "ok"
        ? { status: 200, body: { url: issued.url, headers: issued.headers } }
        : refused(issued.code);
    }
    case "download_url": {
      const issued = await transport.downloadUrl(participant, input);
      return issued.status === "ok"
        ? { status: 200, body: { url: issued.url } }
        : refused(issued.code);
    }
    case "upload_complete": {
      const completed = await transport.completeUpload(participant, input);
      // Also on a retry whose reply was lost, while the target has not started placing: the
      // target's lease may be what went missing. A failed publish fails the request, and the
      // source's retry publishes again.
      if (completed.status !== "refused" && completed.migration.state === "uploaded")
        await dispatch.lease(completed.migration, "target");
      return answer(completed);
    }
    case "fail":
      return answer(await transport.fail(participant, input));
  }
}
