import { expect, test } from "bun:test";
import { handleWorkspaceAssistantCommand } from "#src/server/agents/workspace-assistant-http.server";
import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";

async function assistantFixture() {
  const f = await attachmentCommentsFixture();
  try {
    await f.db.workspaceAssistant.create({ data: { workspaceId: f.workspace.id } });
    const agent = await f.db.agent.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.owner.id,
        name: "attachment-assistant",
        displayName: "Attachment assistant",
        visibility: "private",
        systemKind: "workspace-assistant",
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          reasoning: "",
        },
      },
    });
    await f.db.workspaceAssistantSession.create({
      data: { workspaceId: f.workspace.id, userId: f.owner.id, agentId: agent.id },
    });
    return { ...f, agent };
  } catch (error) {
    await f.close();
    throw error;
  }
}

for (const surface of ["read", "send", "check"] as const) {
  test(`a bound assistant's ${surface} on an attachment target falls through to the dedicated handler`, async () => {
    const f = await assistantFixture();
    try {
      const target = `attachment:${f.attachment.id}`;
      const principal = { workspaceId: f.workspace.id, agentId: f.agent.id };
      const request =
        surface === "send"
          ? new Request("https://coforge.test/api/agent/v1/messages", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                target,
                content: "A review note",
                idempotencyKey: `attachment-${surface}`,
              }),
            })
          : new Request(
              `https://coforge.test/api/agent/v1/${surface === "check" ? "events" : "messages"}?target=${target}&idempotencyKey=attachment-${surface}`,
            );
      expect(await handleWorkspaceAssistantCommand(request, principal, f.db)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

test("a bound assistant's attachment target matches the handler's case-insensitive spelling", async () => {
  const f = await assistantFixture();
  try {
    const principal = { workspaceId: f.workspace.id, agentId: f.agent.id };
    const read = new Request(
      `https://coforge.test/api/agent/v1/messages?target=Attachment:${f.attachment.id}&idempotencyKey=attachment-case-read`,
    );
    expect(await handleWorkspaceAssistantCommand(read, principal, f.db)).toBeUndefined();
    const send = new Request("https://coforge.test/api/agent/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: `Attachment:${f.attachment.id}`,
        content: "A review note",
        idempotencyKey: "attachment-case-send",
      }),
    });
    expect(await handleWorkspaceAssistantCommand(send, principal, f.db)).toBeUndefined();
  } finally {
    await f.close();
  }
});
