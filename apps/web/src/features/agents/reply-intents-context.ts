import { createStoreContext } from "@tanstack/react-store";

import type { ReplyIntentStore } from "./reply-intents";

/** The Workspace's reply intents, provided by `WorkspaceAgentsProvider` and read through
 * `useReplyIntentStore`. */
const { StoreProvider, useStoreContext } = createStoreContext<ReplyIntentStore>();

export { StoreProvider as ReplyIntentStoreProvider, useStoreContext as useReplyIntentStore };
