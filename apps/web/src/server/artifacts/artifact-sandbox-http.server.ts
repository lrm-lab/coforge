import { getDatabaseClient } from "#src/server/db/client.server";
import { productionArtifactSandbox } from "./artifact-composition.server";
import { sandboxRefusal } from "./artifact-sandbox-response.server";

/** Every request to the sandbox origin (task #490), from the server entry. A failure answers as
 * a plain refusal on the sandbox origin, never as one of the application's error pages. */
export async function serveArtifactSandbox(request: Request): Promise<Response> {
  const db = getDatabaseClient();
  if (!db) return sandboxRefusal(503, "Unavailable.");
  try {
    return await productionArtifactSandbox(db).serve(request);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "artifact_sandbox_failed",
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
    return sandboxRefusal(502, "Unavailable.");
  }
}
