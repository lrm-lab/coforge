import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  openLinkArtifact,
  resolvePublicArtifactAccess,
} from "#src/features/artifacts/artifact-sandbox.functions";
import {
  decodeArtifactShortId,
  encodeArtifactShortId,
} from "#src/features/artifacts/artifact-short-id";
import { PublicArtifactShell } from "#src/features/artifacts/public-artifact-shell";
import { isAppErrorCode } from "#src/lib/app-error";

export const Route = createFileRoute("/a/$artifactId")({
  head: () => ({
    meta: [{ name: "robots", content: "noindex" }],
  }),
  loader: async ({ params, location }) => {
    const artifactId = decodeArtifactShortId(params.artifactId);
    if (!artifactId) {
      return { artifact: null, signedIn: false, rateLimited: false, returnTo: location.href };
    }
    const access = await resolvePublicArtifactAccess({ data: { artifactId } });
    if (access.memberWorkspaceSlug) {
      throw redirect({
        to: "/w/$workspaceSlug/artifacts/$artifactId",
        params: {
          workspaceSlug: access.memberWorkspaceSlug,
          artifactId: encodeArtifactShortId(artifactId),
        },
      });
    }
    try {
      const opened = await openLinkArtifact({ data: { artifactId } });
      return {
        artifact: {
          artifactId,
          title: opened.title,
          url: opened.url,
          version: opened.version,
          updatedAt: opened.updatedAt,
        },
        signedIn: access.signedIn,
        rateLimited: false,
        returnTo: location.href,
      };
    } catch (error) {
      if (isAppErrorCode(error, "RATE_LIMITED")) {
        return {
          artifact: null,
          signedIn: access.signedIn,
          rateLimited: true,
          returnTo: location.href,
        };
      }
      if (isAppErrorCode(error, "NOT_FOUND") || isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE")) {
        return {
          artifact: null,
          signedIn: access.signedIn,
          rateLimited: false,
          returnTo: location.href,
        };
      }
      throw error;
    }
  },
  staleTime: 0,
  gcTime: 0,
  component: PublicArtifactRoute,
});

function PublicArtifactRoute() {
  const { artifact, signedIn, rateLimited, returnTo } = Route.useLoaderData();
  return (
    <PublicArtifactShell
      artifact={artifact}
      signedIn={signedIn}
      rateLimited={rateLimited}
      returnTo={returnTo}
    />
  );
}
