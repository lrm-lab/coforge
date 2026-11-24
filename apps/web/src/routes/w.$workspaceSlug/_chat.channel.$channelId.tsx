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

export const Route = createFileRoute("/w/$workspaceSlug/_chat/channel/$channelId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: chatMessageParamSchema,
  }),
  loaderDeps: ({ search }) => conversationPageLoaderDeps(search),
  beforeLoad: ({ params, search, location, cause }) =>
    redirectDocLink(params.workspaceSlug, search, location, { besideChat: true, cause }),
  loader: ({ context, params, deps, parentMatchPromise, cause }) =>
    loadConversationPage(context.queryClient, { kind: "channel", id: params.channelId }, deps, {
      cause,
      workspaceId: () => parentMatchPromise.then(({ loaderData }) => loaderData?.workspaceId ?? ""),
    }),
  remountDeps: ({ params }) => params.channelId,
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelConversationRoute,
});

function ChannelConversationRoute() {
  const { channelId } = Route.useParams();
  return (
    <ConversationPage target={{ kind: "channel", id: channelId }} search={Route.useSearch()} />
  );
}
