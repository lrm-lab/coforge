import { expect, test } from "bun:test";
import { parseAgentLaunchIdentity } from "#src/connection/agent-launch-identity";

test("task conversations survive the launch-config JSON round trip", () => {
  const sent = { name: "scout", features: { taskConversations: true, artifacts: false } };
  expect(parseAgentLaunchIdentity(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
});

test("a features value that is not an object leaves the feature off", () => {
  for (const features of [undefined, null, "on", 1, []])
    expect(parseAgentLaunchIdentity({ name: "scout", features })).toEqual({ name: "scout" });
});

test("a server older than the field sends no features", () => {
  expect(parseAgentLaunchIdentity({ name: "scout" })?.features).toBeUndefined();
});

test("artifacts survive the launch-config JSON round trip beside taskConversations", () => {
  const sent = { name: "scout", features: { taskConversations: true, artifacts: true } };
  expect(parseAgentLaunchIdentity(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
});

test("a features object keeps only the switches the server stated", () => {
  // A server that predates a switch never named it: silence is unknown, not off, so an
  // artifacts-on Workspace behind an older Web keeps its artifact help (task #711).
  expect(
    parseAgentLaunchIdentity({ name: "scout", features: { taskConversations: false } }),
  ).toEqual({ name: "scout", features: { taskConversations: false } });
  expect(parseAgentLaunchIdentity({ name: "scout", features: { artifacts: true } })).toEqual({
    name: "scout",
    features: { artifacts: true },
  });
  expect(parseAgentLaunchIdentity({ name: "scout", features: { artifacts: "yes" } })).toEqual({
    name: "scout",
  });
});
