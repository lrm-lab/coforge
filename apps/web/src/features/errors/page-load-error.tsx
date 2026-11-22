import { useEffect, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlert, Plug } from "kubai-icons/duotone";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { WorkspaceWireframe } from "#src/components/ui/empty-wireframes";
import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import {
  isChunkLoadError,
  showBuildUpdateNotice,
} from "#src/features/updates/build-update-watcher";
import { ErrorPageFrame } from "./error-page-frame";

export function PageLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  if (isAppErrorCode(error, "WORKSPACE_REQUIRED")) {
    return (
      <main className="flex flex-1 flex-col p-6">
        <EmptyState
          size="page"
          role="status"
          headingLevel={1}
          picture={<WorkspaceWireframe />}
          title={m.workspace_unavailable_title()}
          description={m.workspace_unavailable_description()}
          primaryAction={
            <Button onPress={() => void navigate({ to: "/workspaces/new" })}>
              {m.workspace_create()}
            </Button>
          }
        />
      </main>
    );
  }

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const errorId = isAppError(error) ? error.errorId : undefined;

  async function retry() {
    setRetrying(true);
    try {
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      <EmptyState
        size="page"
        role="alert"
        headingLevel={1}
        picture={<EmptyIcon icon={offline ? Plug : CircleAlert} />}
        title={offline ? m.empty_offline_title() : m.empty_page_load_failed_title()}
        description={
          offline ? m.empty_offline_description() : m.empty_page_load_failed_description()
        }
        primaryAction={
          <RetryButton size="page" isRetrying={retrying} onPress={() => void retry()} />
        }
        secondaryAction={
          errorId ? (
            <Button
              size="sm"
              color="tertiary"
              aria-expanded={showDetails}
              onPress={() => setShowDetails((value) => !value)}
            >
              {m.empty_details_toggle()}
            </Button>
          ) : undefined
        }
      />
      {errorId && showDetails && (
        <p className="mt-2 text-center font-mono text-xs text-tertiary">
          {m.error_reference({ errorId })}
        </p>
      )}
    </main>
  );
}

export function GlobalError({ error }: { error: unknown }) {
  const chunkLoadError = isChunkLoadError(error);
  useEffect(() => {
    if (chunkLoadError) showBuildUpdateNotice();
  }, [chunkLoadError]);
  if (chunkLoadError) return <ErrorPageFrame />;
  return (
    <ErrorPageFrame>
      <div className="flex w-full max-w-lg flex-col">
        <PageLoadError error={error} />
      </div>
    </ErrorPageFrame>
  );
}
