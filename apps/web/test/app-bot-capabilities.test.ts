import { describe, expect, test } from "bun:test";

import type { AppBotScope } from "#src/features/apps/app-bot";
import { appBotCapability } from "#src/server/app-bots/app-bot-capabilities.server";

const API = "/api/agent/v1";

describe("what a bot key may call on the Agent API", () => {
  test.each<[string, string, AppBotScope]>([
    ["POST", "/messages", "send"],
    ["GET", "/messages", "read"],
    ["GET", "/messages/search", "read"],
    ["GET", "/messages/0d9f3a1c-0000-4000-8000-000000000000/resolve", "read"],
    ["GET", "/events", "read"],
    ["GET", "/messages/0d9f3a1c-0000-4000-8000-000000000000/mention-deliveries", "mentions"],
    ["GET", "/channels/general", "channels"],
    ["GET", "/users/alice", "channels"],
    ["GET", "/events/", "read"],
  ])("%s %s is covered by %s", (method, path, scope) => {
    expect(appBotCapability(method, `${API}${path}`)).toBe(scope);
  });

  test.each([
    // Tasks, knowledge, attachments, reminders, apps, MCP-style tools and the profile.
    ["POST", "/tasks"],
    ["POST", "/openviking"],
    ["POST", "/memory-dispositions"],
    ["POST", "/attachments"],
    ["GET", "/attachments/abc"],
    ["POST", "/attachment-upload-sessions"],
    ["POST", "/reminders"],
    ["GET", "/apps"],
    ["POST", "/apps/x/token"],
    ["POST", "/actions/prepare"],
    ["GET", "/profile"],
    ["POST", "/profile"],
    ["GET", "/workspace"],
    ["GET", "/manual"],
    ["POST", "/github-credentials"],
    ["POST", "/mention-actions/execute"],
    ["GET", "/mention-actions/pending"],
    ["POST", "/messages/abc/reactions"],
    // Channel management.
    ["POST", "/channels"],
    ["PATCH", "/channels/general"],
    ["POST", "/channels/general/join"],
    ["POST", "/channels/general/leave"],
    ["POST", "/channels/general/archive"],
    ["POST", "/channels/general/mute"],
    ["GET", "/channels/general/members"],
    ["POST", "/channels/general/members"],
    ["DELETE", "/channels/general/members"],
    // The right path with the wrong method, and nothing else.
    ["PUT", "/messages"],
    ["DELETE", "/messages"],
    ["GET", "/nothing-here"],
    // An encoded separator must not turn a covered route into a different one.
    ["GET", "/channels/general%2Fmembers"],
    ["GET", "/channels/general%2fmembers"],
    ["GET", "/messages/abc%2Freactions/resolve"],
    ["GET", "/users/x%2Fy"],
  ])("%s %s is refused", (method, path) => {
    expect(appBotCapability(method, `${API}${path}`)).toBeUndefined();
  });

  test("a path outside the Agent API is not covered", () => {
    expect(appBotCapability("GET", "/api/daemon/ready")).toBeUndefined();
    expect(appBotCapability("POST", "/messages")).toBeUndefined();
  });
});
