import { useRouter } from "@tanstack/react-router";

import { RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

export const isGone = (error: unknown) =>
  isAppError(error) && (error.code === "NOT_FOUND" || error.code === "ACCESS_DENIED");

export function LoadingBody() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-[46rem] space-y-4 px-6 pt-8 md:px-10">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export function ArtifactUnavailable({
  gone,
  retrying = false,
  onRetry,
  onClose,
}: {
  gone: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const Root = onClose ? "div" : "main";
  const Title = onClose ? "h2" : "h1";
  return (
    <Root className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-primary px-6 text-center">
      <Title className="text-md font-medium text-primary">
        {gone ? m.doc_unavailable_title() : m.doc_load_failed_title()}
      </Title>
      <p className="max-w-sm text-sm text-tertiary">
        {gone ? m.doc_load_failed() : m.doc_load_failed_retry()}
      </p>
      <div className="flex items-center gap-4">
        {!gone && onRetry && (
          <Button
            size="sm"
            color="secondary"
            iconLeading={RefreshCw01}
            isLoading={retrying}
            onClick={onRetry}
          >
            {m.doc_retry()}
          </Button>
        )}
        <Button
          size="sm"
          color="link-gray"
          onClick={
            onClose ??
            (() => void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } }))
          }
        >
          {onClose ? m.doc_close() : m.doc_back_to_workspace()}
        </Button>
      </div>
    </Root>
  );
}
