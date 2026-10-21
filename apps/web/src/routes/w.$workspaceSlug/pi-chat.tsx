import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPiChatComputers } from "#src/features/pi-chat/pi-chat.functions";
import { PiChatPage } from "#src/features/pi-chat/pi-chat-page";
import { PiChatPending } from "#src/features/pi-chat/pi-chat-pending";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/pi-chat")({
  validateSearch: z.object({
    computer: z.uuid().optional().catch(undefined),
    session: z
      .union([z.uuid(), z.literal("new")])
      .optional()
      .catch(undefined),
  }),
  loader: () => getPiChatComputers(),
  component: Page,
  pendingComponent: PiChatPending,
  errorComponent: PageLoadError,
});

function Page() {
  const data = Route.useLoaderData();
  const { workspaceSlug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PiChatPage
      {...data}
      workspaceSlug={workspaceSlug}
      computerId={search.computer}
      sessionId={search.session}
      select={(computer, session) => {
        void navigate({ search: { computer, session } });
      }}
    />
  );
}
