import { useQuery } from "@tanstack/react-query";
import { Browser } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { ARTIFACTS_KEY } from "./artifact-queries";

/** The page's link at a version: asked anew each time the page shows, as it is short-lived. */
const sandboxLinkQuery = (artifactId: string, version: number) => ({
  queryKey: [...ARTIFACTS_KEY, "sandbox", artifactId, version],
  queryFn: () => loadArtifactSandboxLink({ data: { artifactId, version } }),
  staleTime: 0,
  gcTime: 0,
  // A new link reloads the frame, and the page would lose what its reader did in it: asked for
  // only as it shows.
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

/**
 * A web page on its artifact's page (task #490, #514): the page itself, framed from the sandbox
 * origin, filling everything under the header (Frank, 11-05: no Source view, no note over it).
 * A person reads it; an Agent changes it, so there is nothing to edit here.
 */
export function ArtifactWebPage({
  artifactId,
  version,
  title,
}: {
  artifactId: string;
  version: number;
  title: string;
}) {
  const link = useQuery(sandboxLinkQuery(artifactId, version));
  if (link.isError) {
    // A deployment without a sandbox origin cannot show web pages at all; anything else may pass.
    const off = isAppError(link.error) && link.error.errorId === "artifact-sandbox-off";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Browser aria-hidden="true" className="size-6 text-fg-quaternary" />
        <p className="text-sm text-secondary">
          {off ? m.doc_page_preview_off() : m.doc_page_preview_failed()}
        </p>
        {!off && (
          <Button
            size="sm"
            color="secondary"
            isLoading={link.isFetching}
            onPress={() => void link.refetch()}
          >
            {m.doc_page_preview_retry()}
          </Button>
        )}
      </div>
    );
  }
  if (!link.data) return <Skeleton className="m-4 flex-1 rounded-xl md:mx-6" />;
  return (
    // The sandbox's wrapper keeps its own origin (`allow-same-origin`, on the sandbox origin, not
    // ours): it frames the page itself, opaque, as `sandboxWrapper` says.
    <iframe
      aria-label={title}
      src={link.data.url}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      className="min-h-[24rem] w-full flex-1 bg-white"
    />
  );
}
