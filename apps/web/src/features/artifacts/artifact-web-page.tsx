import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Browser } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { useAppToast } from "#src/components/ui/toast";
import { isAppError } from "#src/lib/app-error";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { ARTIFACTS_KEY } from "./artifact-queries";
import { PageConfirmDialog } from "./artifact-page-confirm";
import { ArtifactFrameCommentLayer } from "./artifact-frame-comment-layer";
import { PageErrorBanner, PageExpiredCard, PageFindBar } from "./artifact-page-notices";
import { useArtifactPageBridge } from "./use-artifact-page-bridge";

const sandboxLinkQuery = (artifactId: string, version: number) => ({
  queryKey: [...ARTIFACTS_KEY, "sandbox", artifactId, version],
  queryFn: () => loadArtifactSandboxLink({ data: { artifactId, version } }),
  staleTime: 0,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

type PageLink = Awaited<ReturnType<typeof loadArtifactSandboxLink>>;

export function ArtifactWebPage({
  artifactId,
  version,
  title,
  entryPath,
  finding,
  onFindingChange,
}: {
  artifactId: string;
  version: number;
  title: string;
  entryPath: string;
  finding: boolean;
  onFindingChange: (finding: boolean) => void;
}) {
  const link = useQuery(sandboxLinkQuery(artifactId, version));
  if (link.isError) {
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
    <PageFrame
      key={link.data.url}
      link={link.data}
      artifactId={artifactId}
      version={version}
      title={title}
      entryPath={entryPath}
      finding={finding}
      onFindingChange={onFindingChange}
      onReload={() => void link.refetch()}
    />
  );
}

function PageFrame({
  link,
  artifactId,
  version,
  title,
  entryPath,
  finding,
  onFindingChange,
  onReload,
}: {
  link: PageLink;
  artifactId: string;
  version: number;
  title: string;
  entryPath: string;
  finding: boolean;
  onFindingChange: (finding: boolean) => void;
  onReload: () => void;
}) {
  const toast = useAppToast();
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const origin = useMemo(() => new URL(link.url).origin, [link.url]);
  const artifact = useMemo(
    () => ({ id: artifactId, title, version, entryPath }),
    [artifactId, title, version, entryPath],
  );
  const { bridge, confirmation, error, dismissError, blocked, found } = useArtifactPageBridge({
    frame,
    origin,
    viewer: link.viewer,
    level: link.level,
    artifact,
  });
  const askAgent = async () => {
    const report = m.doc_page_error_report({
      version,
      width: frame.current?.clientWidth ?? window.innerWidth,
      message: error ?? "",
    });
    if (await copyText(report)) toast.success(m.doc_page_error_copied());
    else toast.error(m.conversation_copy_failed());
    dismissError();
  };
  return (
    <>
      {error !== null && (
        <PageErrorBanner onAskAgent={() => void askAgent()} onClose={dismissError} />
      )}
      <div ref={container} className="relative flex min-h-0 flex-1 flex-col">
        <iframe
          ref={frame}
          aria-label={title}
          src={link.url}
          sandbox="allow-scripts allow-same-origin"
          allow="clipboard-read 'none'; clipboard-write 'none'"
          referrerPolicy="no-referrer"
          className="min-h-[24rem] w-full flex-1 bg-white"
        />
        {finding && (
          <PageFindBar
            found={found}
            onFind={(query, step) => bridge.find({ query, step })}
            onClose={() => {
              bridge.find({ query: "", step: 0 });
              onFindingChange(false);
            }}
          />
        )}
        <ArtifactFrameCommentLayer bridge={bridge} frame={frame} container={container} />
        {blocked && <PageExpiredCard onReload={onReload} />}
      </div>
      <PageConfirmDialog confirmation={confirmation} title={title} />
    </>
  );
}
