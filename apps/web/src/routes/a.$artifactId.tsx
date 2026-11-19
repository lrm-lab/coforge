import { createFileRoute } from "@tanstack/react-router";

import { openLinkArtifact } from "#src/features/artifacts/artifact-sandbox.functions";
import { decodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import { PublicArtifactShell } from "#src/features/artifacts/public-artifact-shell";
import { isAppErrorCode } from "#src/lib/app-error";

export const Route = createFileRoute("/a/$artifactId")({
  loader: async ({ params }) => {
    const artifactId = decodeArtifactShortId(params.artifactId);
    if (!artifactId) return { artifact: null, rateLimited: false };
    try {
      const opened = await openLinkArtifact({ data: { artifactId } });
      return {
        artifact: {
          artifactId,
          title: opened.title,
          url: opened.url,
          version: opened.version,
        },
        rateLimited: false,
      };
    } catch (error) {
      if (isAppErrorCode(error, "RATE_LIMITED")) {
        return { artifact: null, rateLimited: true };
      }
      if (isAppErrorCode(error, "NOT_FOUND") || isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE")) {
        return { artifact: null, rateLimited: false };
      }
      throw error;
    }
  },
  staleTime: 0,
  gcTime: 0,
  component: PublicArtifactRoute,
});

function PublicArtifactRoute() {
  const { artifact, rateLimited } = Route.useLoaderData();
  return <PublicArtifactShell artifact={artifact} rateLimited={rateLimited} />;
}
