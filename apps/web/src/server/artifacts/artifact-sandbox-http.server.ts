import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { viewportDiagnostic } from "./viewport-216.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { productionArtifactSandbox } from "./artifact-composition.server";
import { sandboxRefusal } from "./artifact-sandbox-response.server";

export async function serveArtifactSandbox(request: Request): Promise<Response> {
  const diagnostic = viewportDiagnostic(request, artifactSandboxOrigin());
  if (diagnostic) return diagnostic;
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
