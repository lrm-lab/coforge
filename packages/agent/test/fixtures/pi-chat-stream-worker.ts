import { runPiChatWorker } from "@coforge/agent";

const workspaceId = Bun.env.COFORGE_PI_CHAT_WORKSPACE_ID!;
const userId = Bun.env.COFORGE_PI_CHAT_USER_ID!;
for (const key of Object.keys(Bun.env)) if (key.startsWith("COFORGE_")) delete Bun.env[key];
await runPiChatWorker(Bun.argv[2]!, workspaceId, userId, { stream: true });
