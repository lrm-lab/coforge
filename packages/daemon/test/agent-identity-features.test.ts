import { expect, test } from "bun:test";
import { parseAgentLaunchIdentity } from "#src/connection/agent-launch-identity";

test("task conversations survive the launch-config JSON round trip", () => {
  const sent = { name: "scout", features: { taskConversations: true } };
  expect(parseAgentLaunchIdentity(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
});

test("anything but taskConversations true leaves the feature off", () => {
  for (const features of [
    undefined,
    null,
    "on",
    1,
    [],
    {},
    { taskConversations: false },
    { taskConversations: "true" },
    { taskConversations: 1 },
    { other: true },
  ])
    expect(parseAgentLaunchIdentity({ name: "scout", features })).toEqual({ name: "scout" });
});

test("a server older than the field sends no features", () => {
  expect(parseAgentLaunchIdentity({ name: "scout" })?.features).toBeUndefined();
});
