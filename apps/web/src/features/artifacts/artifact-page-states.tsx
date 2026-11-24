import { useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
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
  const backAction = (
    <Button
      size="sm"
      color={gone ? "secondary" : "tertiary"}
      onPress={
        onClose ??
        (() => void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } }))
      }
    >
      {onClose ? m.doc_close() : m.doc_back_to_workspace()}
    </Button>
  );
  return (
    <Root className="flex h-full min-w-0 flex-1 flex-col bg-primary">
      <EmptyState
        headingLevel={onClose ? 2 : 1}
        role={gone ? undefined : "alert"}
        picture={gone ? <LockedWireframe /> : <EmptyIcon icon={AlertCircle} />}
        title={gone ? m.doc_unavailable_title() : m.doc_load_failed_title()}
        description={gone ? m.doc_load_failed() : m.doc_load_failed_retry()}
        primaryAction={
          !gone && onRetry ? (
            <RetryButton isRetrying={retrying} label={m.doc_retry()} onPress={onRetry} />
          ) : (
            backAction
          )
        }
        secondaryAction={!gone && onRetry ? backAction : undefined}
      />
    </Root>
  );
}
