import { useEffect, useState } from "react";
import { useMatch, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { z } from "zod";
import { AlertCircle } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
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
  // An artifact linked beside a conversation the viewer cannot open (`?doc=`), whatever the
  // reason: its own page decides, as one the Workspace may read is still theirs (task #529).
  // Read once: leaving for it changes the address, which must not then read as no link at all.
  const search = useRouterState({ select: (state) => state.location.search });
  const [doc] = useState(() => {
    const id = (search as { doc?: unknown }).doc;
    return z.uuid().safeParse(id).success ? (id as string) : undefined;
  });
  // A conversation that no longer exists for the viewer (a channel hidden from the Workspace)
  // leaves for Chat, which opens the viewer's next conversation. The channel list is re-read
  // first, so Chat does not land straight back on the channel that just went away.
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationBackHeader>
        <h1 className="text-md font-semibold">{m.messages_title()}</h1>
      </ConversationBackHeader>
      <div className="grid flex-1 place-content-center gap-4 p-6 text-center">
        <AlertCircle aria-hidden="true" className="mx-auto size-5 text-error-primary" />
        <p role="alert" className="text-sm">
          {m.conversation_history_load_error()}
        </p>
        {isAppError(error) && error.errorId && (
          <p className="text-xs text-tertiary">{m.error_reference({ errorId: error.errorId })}</p>
        )}
        <Button
          color="secondary"
          className="justify-self-center"
          onPress={() => void router.invalidate({ filter: (match) => match.routeId === routeId })}
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
