import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { redirectDocLink } from "#src/features/artifacts/artifact-search";
import { ConversationLoadError } from "#src/features/conversations/conversation-load-error";
import { ConversationPending } from "#src/features/conversations/conversation-pending";
import {
  chatMessageParamSchema,
  conversationPageSearchShape,
} from "#src/features/conversations/conversation-page-search";
import {
  conversationPageLoaderDeps,
  loadConversationPage,
} from "#src/features/conversations/conversation-page-loader";
import { ConversationPage } from "#src/features/conversations/conversation-page";

export const Route = createFileRoute("/w/$workspaceSlug/_chat/dm/$dmId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: chatMessageParamSchema,
  }),
  loaderDeps: ({ search }) => conversationPageLoaderDeps(search),
  beforeLoad: ({ params, search, location, cause }) =>
    redirectDocLink(params.workspaceSlug, search, location, { besideChat: true, cause }),
  loader: async ({ context, params, deps, parentMatchPromise, cause }) => {
    await loadConversationPage(context.queryClient, { kind: "dm", id: params.dmId }, deps, {
      cause,
      workspaceId: () => parentMatchPromise.then(({ loaderData }) => loaderData?.workspaceId ?? ""),
    });
  },
  remountDeps: ({ params }) => params.dmId,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationRoute,
});

function DirectConversationRoute() {
  const { dmId } = Route.useParams();
  return <ConversationPage target={{ kind: "dm", id: dmId }} search={Route.useSearch()} />;
}
