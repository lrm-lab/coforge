import { describe, expect, test } from "bun:test";

import { arrangeTabs, isTabOrder } from "#src/features/panel-tabs/panel-tab-order";
import {
  agentIdFromProfileParam,
  agentProfileSearchWithoutThread,
  agentProfileTabParamSchema,
  formatAgentProfileParam,
  formatPersonProfileParam,
  profileParamSchema,
  personIdFromProfileParam,
  resolveAgentProfileTab,
  visibleAgentProfileTabs,
  AGENT_PROFILE_TABS,
} from "#src/features/agents/profile-panel/profile-panel-search";

const AGENT_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

describe("profileParamSchema", () => {
  test("opens either an Agent or a person", () => {
    expect(profileParamSchema.parse(formatAgentProfileParam(AGENT_ID))).toBe(`agent:${AGENT_ID}`);
    expect(profileParamSchema.parse(formatPersonProfileParam(AGENT_ID))).toBe(`user:${AGENT_ID}`);
  });

  test("accepts a missing value and falls back to undefined for a malformed token", () => {
    expect(profileParamSchema.parse(undefined)).toBeUndefined();
    expect(profileParamSchema.parse("")).toBeUndefined();
    expect(profileParamSchema.parse("agent:not-a-uuid")).toBeUndefined();
    expect(profileParamSchema.parse("user:not-a-uuid")).toBeUndefined();
    expect(profileParamSchema.parse(`channel:${AGENT_ID}`)).toBeUndefined();
  });
});

describe("personIdFromProfileParam", () => {
  test("extracts a person's id and ignores an Agent's", () => {
    expect(personIdFromProfileParam(formatPersonProfileParam(AGENT_ID))).toBe(AGENT_ID);
    expect(personIdFromProfileParam(formatAgentProfileParam(AGENT_ID))).toBeUndefined();
    expect(personIdFromProfileParam("user:nope")).toBeUndefined();
    expect(personIdFromProfileParam(undefined)).toBeUndefined();
  });
});

describe("agentProfileTabParamSchema", () => {
  test("accepts the panel's tabs and rejects anything else", () => {
    expect(agentProfileTabParamSchema.parse("profile")).toBe("profile");
    expect(agentProfileTabParamSchema.parse("reminders")).toBe("reminders");
    expect(agentProfileTabParamSchema.parse("activity")).toBe("activity");
    expect(agentProfileTabParamSchema.parse("workspace")).toBe("workspace");
    expect(agentProfileTabParamSchema.parse("computer")).toBeUndefined();
    expect(agentProfileTabParamSchema.parse("nonsense")).toBeUndefined();
    expect(agentProfileTabParamSchema.parse(undefined)).toBeUndefined();
  });
});

describe("agentIdFromProfileParam", () => {
  test("extracts the id from a valid token", () => {
    expect(agentIdFromProfileParam(formatAgentProfileParam(AGENT_ID))).toBe(AGENT_ID);
  });

  test("returns undefined for a missing or malformed token", () => {
    expect(agentIdFromProfileParam(undefined)).toBeUndefined();
    expect(agentIdFromProfileParam("agent:nope")).toBeUndefined();
    expect(agentIdFromProfileParam(`channel:${AGENT_ID}`)).toBeUndefined();
  });
});

describe("agentProfileSearchWithoutThread", () => {
  test("removes the active thread while preserving unrelated search state", () => {
    expect(
      agentProfileSearchWithoutThread({
        view: "chat",
        threadRootId: "thread-1",
        profile: "agent:agent-1",
      }),
    ).toEqual({ view: "chat", profile: "agent:agent-1" });
  });
});

describe("visibleAgentProfileTabs", () => {
  test("shows Activity, Chat, Reminders and Workspace to the Agent's managers, Profile and Apps to everyone", () => {
    expect(visibleAgentProfileTabs(false, true, false)).toEqual(["profile", "apps"]);
    expect(visibleAgentProfileTabs(true, true, true)).toEqual([
      "profile",
      "activity",
      "chat",
      "reminders",
      "workspace",
      "apps",
    ]);
  });

  test("an app's bot shows Profile and Chat to everyone who opens it", () => {
    expect(visibleAgentProfileTabs(false, false, true)).toEqual(["profile", "chat"]);
  });

  test("an archived Agent shows Profile alone", () => {
    expect(visibleAgentProfileTabs(false, false, false)).toEqual(["profile"]);
  });

  test("opens on Profile, then lists Activity, Chat, Reminders, Workspace and Apps by default", () => {
    expect(visibleAgentProfileTabs(true, true, true)).toEqual([...AGENT_PROFILE_TABS]);
  });

  test("a saved order that predates Chat gets it in its default place among the rest", () => {
    const saved = ["apps", "profile", "activity"] as const;
    expect(arrangeTabs(visibleAgentProfileTabs(true, true, true), saved)).toEqual([
      "apps",
      "profile",
      "activity",
      "chat",
      "reminders",
      "workspace",
    ]);
    expect(isTabOrder("agentProfile", saved)).toBeTrue();
    expect(isTabOrder("agentProfile", ["chat", "profile"])).toBeTrue();
  });
});

describe("resolveAgentProfileTab", () => {
  test("opens on the first tab of the viewer's order when nothing was requested", () => {
    expect(resolveAgentProfileTab(undefined, ["profile", "activity"])).toBe("profile");
    expect(resolveAgentProfileTab(undefined, ["activity", "profile"])).toBe("activity");
  });

  test("honors a requested tab the viewer can see", () => {
    expect(resolveAgentProfileTab("profile", ["activity", "profile"])).toBe("profile");
    expect(resolveAgentProfileTab("workspace", ["profile", "workspace"])).toBe("workspace");
  });

  test("falls back to the first tab when the requested one is hidden from the viewer", () => {
    expect(resolveAgentProfileTab("workspace", ["reminders", "profile"])).toBe("reminders");
    expect(resolveAgentProfileTab("activity", ["profile"])).toBe("profile");
  });
});
