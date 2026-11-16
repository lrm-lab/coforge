import type { TeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import { decodeTeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import { TeamMemoryError, type TeamMemory, type TeamMemoryActor } from "./memory";

async function readCommand(request: Request): Promise<TeamMemoryCommand> {
  const reader = request.body?.getReader();
  if (!reader) throw new TeamMemoryError("invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 96 * 1024) {
        await reader.cancel();
        throw new TeamMemoryError("invalid");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return decodeTeamMemoryCommand(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new TeamMemoryError("invalid");
  }
}

export async function handleTeamMemory(
  request: Request,
  actor: TeamMemoryActor,
  memory: TeamMemory,
): Promise<Response> {
  try {
    return Response.json(await memory.execute(actor, await readCommand(request)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof TeamMemoryError)
      return Response.json(
        { errorCode: error.message, error: error.message },
        {
          status:
            error.code === "forbidden"
              ? 403
              : error.code === "not_found"
                ? 404
                : error.code === "conflict"
                  ? 409
                  : 400,
          headers: { "cache-control": "no-store" },
        },
      );
    return Response.json(
      {
        errorCode: "memory_unavailable",
        error: "Team memory is unavailable; continue with local context.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
