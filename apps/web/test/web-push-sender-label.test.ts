import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import { SYSTEM_SENDER_LABEL } from "#src/features/profiles/person-name";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";

type Sender = {
  agent: { name: string } | null;
  user: { username: string; displayName: string } | null;
};

/** The notification `notificationForRecipient` builds for a message from `sender`. */
async function notificationFor(input: {
  sender: Sender | null;
  channelName: string | null;
  body?: string;
  mentions?: unknown[];
}) {
  const db = {
    message: {
      findUnique: async () => ({
        id: "message-1",
        body: input.body ?? "Build finished",
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        senderMemberId: "member-2",
        threadRootId: null,
        sender: input.sender,
        mentions: input.mentions ?? [],
        conversation: { channelName: input.channelName, workspace: { slug: "acme" } },
      }),
    },
    conversationMember: { findFirst: async () => ({ id: "member-1" }) },
  } as unknown as PrismaClient;
  return new PrismaWebPushSubscriptionStore(db).notificationForRecipient("message-1", "user-1");
}

const frank = (names: { displayName: string }) => ({
  agent: null,
  user: { username: "frank-an-4k2", ...names },
});

describe("the sender a Web Push notification names", () => {
  test("a person in a direct conversation is the notification title, by their label, never their username", async () => {
    expect(
      await notificationFor({
        sender: frank({ displayName: "Frankie" }),
        channelName: null,
      }),
    ).toMatchObject({ title: "Frankie", body: "Build finished" });
    const unnamed = await notificationFor({
      sender: frank({ displayName: "  " }),
      channelName: null,
    });
    expect(unnamed).toMatchObject({ title: UNNAMED_PERSON_NAME });
    expect(JSON.stringify(unnamed)).not.toContain("frank-an-4k2");
  });

  test("a person in a channel prefixes the preview with their label", async () => {
    expect(
      await notificationFor({
        sender: frank({ displayName: "Frankie" }),
        channelName: "general",
      }),
    ).toMatchObject({ title: "#general", body: "Frankie: Build finished" });
  });

  test("an Agent keeps its @handle", async () => {
    const sender = { agent: { name: "helper" }, user: null };
    expect(await notificationFor({ sender, channelName: null })).toMatchObject({
      title: "@helper",
    });
    expect(await notificationFor({ sender, channelName: "general" })).toMatchObject({
      body: "@helper: Build finished",
    });
  });

  test("a server-authored message is from the system sender, the name nobody may take", async () => {
    expect(await notificationFor({ sender: null, channelName: null })).toMatchObject({
      title: SYSTEM_SENDER_LABEL,
    });
  });

  test("a mention of a person reads as their name, never their username", async () => {
    const graceId = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(
      await notificationFor({
        sender: frank({ displayName: "Frankie" }),
        channelName: "general",
        body: `hi <@human:${graceId}> please review`,
        mentions: [
          {
            kind: "user",
            actorId: graceId,
            handle: "grace-hopper-4k2",
            member: { user: { displayName: "Grace Hopper" }, agent: null },
          },
        ],
      }),
    ).toMatchObject({ body: "Frankie: hi @Grace Hopper please review" });
  });
});
