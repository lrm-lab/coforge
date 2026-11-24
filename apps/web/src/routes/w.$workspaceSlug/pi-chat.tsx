import { useCallback } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { workbenchRuntimeSchema } from "@lrm/coforge-sdk/internal/pi-chat";
import { getPiChatComputers } from "#src/features/pi-chat/pi-chat.functions";
import { PiChatPage } from "#src/features/pi-chat/pi-chat-page";
import { PiChatPending } from "#src/features/pi-chat/pi-chat-pending";
import { fetchAiWorkbenchEnabled } from "#src/features/settings/ai-workbench";
import { PiChatOff } from "#src/features/pi-chat/pi-chat-off";
import { isAppErrorCode } from "#src/lib/app-error";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/pi-chat")({
  validateSearch: z.object({
    computer: z.uuid().optional().catch(undefined),
    runtime: workbenchRuntimeSchema.optional().catch(undefined),
    session: z
      .union([z.uuid(), z.literal("new")])
      .optional()
      .catch(undefined),
  }),
  // Read fresh, so a switch turned off elsewhere is honoured before the page opens.
  beforeLoad: async ({ params, context }) => {
    if (!(await fetchAiWorkbenchEnabled(context.queryClient)))
      throw redirect({
        to: "/w/$workspaceSlug",
        params: { workspaceSlug: params.workspaceSlug },
      });
  },
  loader: () => getPiChatComputers(),
  component: Page,
  pendingComponent: PiChatPending,
  errorComponent: (props) =>
    isAppErrorCode(props.error, "ACCESS_DENIED") ? <PiChatOff /> : <PageLoadError {...props} />,
});

function Page() {
  const data = Route.useLoaderData();
  const { workspaceSlug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const handleSelect = useCallback(
    (computer: string | undefined, session: string | undefined, runtime: typeof search.runtime) => {
      void navigate({ search: { computer, session, runtime } });
    },
    [navigate],
  );
  return (
    <PiChatPage
      {...data}
      workspaceSlug={workspaceSlug}
      computerId={search.computer}
      sessionId={search.session}
      runtime={search.runtime}
      select={handleSelect}
    />
  );
}
