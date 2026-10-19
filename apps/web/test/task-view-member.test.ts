import { describe, expect, test } from "bun:test";

import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { taskMember } from "#src/server/tasks/task-view.server";

type Member = Parameters<typeof taskMember>[1];

const person = (names: { displayName: string }): Member => ({
  id: "member-1",
  userId: "user-1",
  agentId: null,
  leftAt: null,
  user: { username: "frank-an-4k2", avatarObjectKey: null, ...names },
  agent: null,
});

describe("taskMember", () => {
  test("a person is named by the label teammates see, without an @", () => {
    expect(taskMember("workspace-1", person({ displayName: "Frankie" })).name).toBe("Frankie");
    // Never the username, even for a blank name.
    expect(taskMember("workspace-1", person({ displayName: "  " })).name).toBe("Unnamed");
  });

  test("the handle stays on the member, for the Agent-facing view", () => {
    expect(taskMember("workspace-1", person({ displayName: "Frankie" }))).toMatchObject({
      kind: "user",
      id: "user-1",
      handle: "frank-an-4k2",
    });
  });

  const agent = (fields: { avatarObjectKey: string | null; deletedAt?: Date | null }): Member => ({
    id: "member-2",
    userId: null,
    agentId: "agent-1",
    leftAt: null,
    user: null,
    agent: { name: "atlas", displayName: "Atlas Bot", deletedAt: null, ...fields },
  });

  test("an Agent is still its display name, with its @handle as the handle", () => {
    expect(taskMember("workspace-1", agent({ avatarObjectKey: null }))).toMatchObject({
      kind: "agent",
      name: "Atlas Bot",
      handle: "atlas",
    });
  });

  // Task #11: the Task popup, cards and rows showed an Agent's initial although it has an avatar.
  test("an Agent carries its avatar, as its messages and member rows show it", () => {
    const key = "workspaces/workspace-1/agents/agent-1/avatars/v1/original";
    expect(taskMember("workspace-1", agent({ avatarObjectKey: key })).avatarUrl).toBe(
      agentAvatarUrl("workspace-1", "agent-1", key),
    );
    // A deleted Agent keeps its avatar URL, as its messages do; the popup greys it beside its marker.
    expect(
      taskMember("workspace-1", agent({ avatarObjectKey: key, deletedAt: new Date() })),
    ).toMatchObject({ deleted: true, avatarUrl: agentAvatarUrl("workspace-1", "agent-1", key) });
    expect(taskMember("workspace-1", agent({ avatarObjectKey: null })).avatarUrl).toBeNull();
  });
});
