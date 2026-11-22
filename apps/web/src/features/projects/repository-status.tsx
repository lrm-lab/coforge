import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlert, Folder } from "kubai-icons/duotone";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

export function RepositoryStatusMessage({
  status,
  onRetry,
}: {
  status: "unlinked" | "denied" | "unavailable";
  onRetry?: () => Promise<unknown>;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const [retrying, setRetrying] = useState(false);

  const openGitHubSettings = () => {
    void navigate({
      to: "/w/$workspaceSlug/settings",
      params: { workspaceSlug },
      search: { section: "integrations" },
    });
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await (onRetry ? onRetry() : router.invalidate({ sync: true }));
    } finally {
      setRetrying(false);
    }
  };

  if (status === "unlinked") {
    return (
      <EmptyState
        className="min-h-52"
        picture={<EmptyIcon icon={Folder} />}
        title={m.project_no_repository()}
        primaryAction={
          <Button size="sm" color="secondary" onPress={openGitHubSettings}>
            {m.project_github_settings()}
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      className="min-h-52"
      role={status === "unavailable" ? "alert" : undefined}
      picture={status === "denied" ? <LockedWireframe /> : <EmptyIcon icon={CircleAlert} />}
      title={
        status === "denied" ? m.project_repository_denied() : m.project_repository_unavailable()
      }
      description={status === "unavailable" ? m.empty_load_failed_safe() : undefined}
      primaryAction={
        <RetryButton
          isRetrying={retrying}
          label={m.project_retry()}
          onPress={() => void handleRetry()}
        />
      }
      secondaryAction={
        <Button size="sm" color="tertiary" onPress={openGitHubSettings}>
          {m.project_github_settings()}
        </Button>
      }
    />
  );
}
