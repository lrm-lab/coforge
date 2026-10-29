import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getAgentSendChannel } from "#src/server/conversations/channel-access.server";

/** The reads `getAgentSendChannel` makes for an Agent that is not a member of `#general`. */
function fakeDb(options: { publicAgent?: boolean; appBot?: boolean; archived?: boolean } = {}) {
  return {
    conversation: {
      findFirst: async () => ({
        id: "channel-general",
        channelName: "general",
        archivedAt: options.archived ? new Date() : null,
        members: [],
      }),
    },
    agent: {
      findFirst: async () => ({
        visibility: options.publicAgent === false ? "private" : "public",
      }),
    },
    appInstallationBot: {
      findFirst: async () => (options.appBot ? { id: "bot-1" } : null),
    },
  } as unknown as PrismaClient;
}

const resolve = (options: Parameters<typeof fakeDb>[0]) =>
  getAgentSendChannel(fakeDb(options), "workspace-1", "agent-1", "#general");

test("a public Agent may still join a visible channel on the way to posting", async () => {
  await expect(resolve({})).resolves.toEqual({
    id: "channel-general",
    channelName: "general",
    needsJoin: true,
  });
});

test("an app's bot posts only where it was added, never by joining on the way", async () => {
  // Installed identity, not a Workspace member: the same refusal a non-member always had.
  await expect(resolve({ appBot: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("a private Agent and an archived channel keep their refusal", async () => {
  await expect(resolve({ publicAgent: false })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(resolve({ archived: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});
