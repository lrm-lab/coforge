import { expect, test } from "bun:test";
import {
  CHANNEL_LIST_MEMBER_LIMIT,
  previewSenderOf,
} from "#src/server/conversations/channel-list-preview.server";

test("the channel list shows at most six members", () => {
  expect(CHANNEL_LIST_MEMBER_LIMIT).toBe(6);
});

test("a person sender is named by their label and marked mine only for the viewer", () => {
  const names = {
    users: new Map([["user-grace", { username: "grace", displayName: null }]]),
    agents: new Map(),
  };
  expect(
    previewSenderOf({ senderUserId: "user-grace", senderAgentId: null }, "user-grace", names),
  ).toEqual({
    kind: "user",
    name: "grace",
    mine: true,
  });
  expect(
    previewSenderOf({ senderUserId: "user-grace", senderAgentId: null }, "user-ada", names),
  ).toEqual({
    kind: "user",
    name: "grace",
    mine: false,
  });
});

test("an Agent sender is named by its display name, then its name", () => {
  const names = {
    users: new Map(),
    agents: new Map([
      ["agent-helper", { name: "helper", displayName: "Helper" }],
      ["agent-bare", { name: "bare", displayName: null }],
    ]),
  };
  expect(
    previewSenderOf({ senderUserId: null, senderAgentId: "agent-helper" }, "user-ada", names),
  ).toEqual({
    kind: "agent",
    name: "Helper",
    mine: false,
  });
  expect(
    previewSenderOf({ senderUserId: null, senderAgentId: "agent-bare" }, "user-ada", names),
  ).toEqual({
    kind: "agent",
    name: "bare",
    mine: false,
  });
});

test("a message with no sender member is from the system", () => {
  expect(
    previewSenderOf({ senderUserId: null, senderAgentId: null }, "user-ada", {
      users: new Map(),
      agents: new Map(),
    }),
  ).toEqual({ kind: "system", name: "System", mine: false });
});
