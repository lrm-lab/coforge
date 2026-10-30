import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { readChatLists } from "#src/server/conversations/chat-lists.server";
import { CHAT_LIST_READS } from "./chat-list-reads";

/**
 * The Chat page's lists named in `lists`, read in one call (`readChatLists`): the page asks for
 * every list it needs at once (`readChatList`) instead of one call, and one sign-in and membership
 * check, per list.
 */
export const loadChatLists = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ lists: z.array(z.enum(CHAT_LIST_READS)).min(1) }))
  .handler(({ context, data }) => {
    declareNoStore();
    return readChatLists(context, data.lists);
  });
