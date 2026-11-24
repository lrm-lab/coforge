import { useEffect, useState } from "react";
import { useMatch, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";
import { z } from "zod";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { artifactPageRoute } from "#src/features/artifacts/artifact-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ConversationBackHeader } from "./conversation-list-button";
import { ConversationPending } from "./conversation-pending";
import { isConversationGone } from "./conversation-queries";
import { useRefreshSidebarChannels } from "./sidebar-lists";

export function ConversationLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const gone = isConversationGone(error);
  const search = useRouterState({ select: (state) => state.location.search });
  const [doc] = useState(() => {
    const id = (search as { doc?: unknown }).doc;
    return z.uuid().safeParse(id).success ? (id as string) : undefined;
  });
  const [retrying, setRetrying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (doc) {
      void navigate({ ...artifactPageRoute(workspaceSlug, doc), replace: true });
      return;
    }
    if (!gone) return;
    void refreshSidebarChannels().finally(
      () => void navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug }, replace: true }),
    );
  }, [gone, doc, navigate, workspaceSlug, refreshSidebarChannels]);

  if (gone || doc) return <ConversationPending />;

  const errorId = isAppError(error) ? error.errorId : undefined;
  async function retry() {
    setRetrying(true);
    try {
      await router.invalidate({ filter: (match) => match.routeId === routeId });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationBackHeader>
        <h1 className="text-md font-semibold">{m.messages_title()}</h1>
      </ConversationBackHeader>
      <EmptyState
        size="page"
        role="alert"
        picture={<EmptyIcon icon={AlertCircle} />}
        title={m.empty_conversation_load_failed_title()}
        description={m.empty_load_failed_safe()}
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
        <p className="pb-6 text-center font-mono text-xs text-tertiary">
          {m.error_reference({ errorId })}
        </p>
      )}
    </div>
  );
}
