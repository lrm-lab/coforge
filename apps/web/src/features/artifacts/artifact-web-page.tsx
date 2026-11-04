import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { ARTIFACTS_KEY } from "./artifact-queries";

/** The page's link at a version: asked anew each time the page shows, as it is short-lived. */
const sandboxLinkQuery = (artifactId: string, version: number) => ({
  queryKey: [...ARTIFACTS_KEY, "sandbox", artifactId, version],
  queryFn: () => loadArtifactSandboxLink({ data: { artifactId, version } }),
  staleTime: 0,
  gcTime: 0,
});

/**
 * A web page on its artifact's page (task #490, #514): the page itself, framed from the sandbox
 * origin, or its source. A person reads it; an Agent changes it, so there is no editor here.
 */
export function ArtifactWebPage({
  artifactId,
  version,
  title,
  source,
}: {
  artifactId: string;
  version: number;
  title: string;
  /** The page's HTML at `version`, once read. */
  source: string | undefined;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 pt-3 md:px-6">
        <ButtonGroup
          aria-label={m.doc_page_view()}
          size="sm"
          selectedKeys={[view]}
          disallowEmptySelection
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next === "preview" || next === "source") setView(next);
          }}
        >
          <ButtonGroupItem id="preview">{m.doc_page_preview()}</ButtonGroupItem>
          <ButtonGroupItem id="source">{m.doc_page_source()}</ButtonGroupItem>
        </ButtonGroup>
        <span className="ml-auto truncate text-xs text-tertiary max-sm:hidden">
          {m.doc_page_agent_hint()}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4 md:px-6">
        {view === "preview" ? (
          <Preview artifactId={artifactId} version={version} title={title} />
        ) : source === undefined ? (
          <Skeleton className="h-full w-full rounded-xl" />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto rounded-xl bg-secondary p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-secondary ring-1 ring-secondary">
            {source}
          </pre>
        )}
      </div>
    </div>
  );
}

function Preview({
  artifactId,
  version,
  title,
}: {
  artifactId: string;
  version: number;
  title: string;
}) {
  const link = useQuery(sandboxLinkQuery(artifactId, version));
  if (link.isError) return <p className="text-sm text-tertiary">{m.doc_page_preview_failed()}</p>;
  if (!link.data) return <Skeleton className="h-full w-full rounded-xl" />;
  return (
    // The sandbox's wrapper keeps its own origin (`allow-same-origin`, on the sandbox origin, not
    // ours): it frames the page itself, opaque, as `sandboxWrapper` says.
    <iframe
      title={title}
      src={link.data.url}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      className="min-h-[24rem] w-full flex-1 rounded-xl bg-white ring-1 ring-secondary"
    />
  );
}
