import { describe, expect, test } from "bun:test";
import {
  actionCardActionSchema,
  APP_GRANT_AGENT_CARD_KIND,
  agentCreateActionSchema,
  channelAddMemberActionSchema,
  channelCreateActionSchema,
  pageFillActionSchema,
  validateActionCardAction,
} from "./action-cards";

describe("channelCreateActionSchema", () => {
  test("accepts a minimal public channel", () => {
    const parsed = channelCreateActionSchema.parse({ type: "channel:create", name: "design" });
    expect(parsed).toEqual({ type: "channel:create", name: "design", visibility: "public" });
  });

  test("accepts a leading '#' and strips it", () => {
    const parsed = channelCreateActionSchema.parse({ type: "channel:create", name: "#design" });
    expect(parsed.name).toBe("design");
  });

  test("accepts private visibility at the schema layer (server rejects it for now)", () => {
    const parsed = channelCreateActionSchema.parse({
      type: "channel:create",
      name: "design",
      visibility: "private",
    });
    expect(parsed.visibility).toBe("private");
  });

  test("accepts handles and UUIDs in initialHumans/initialAgents plus a draftHint", () => {
    const parsed = channelCreateActionSchema.parse({
      type: "channel:create",
      name: "design",
      description: "Design discussion",
      initialHumans: ["@alice", "bob", "11111111-1111-1111-1111-111111111111"],
      initialAgents: ["@scout"],
      draftHint: "Requested by the owner in #general",
    });
    expect(parsed.initialHumans).toEqual(["@alice", "bob", "11111111-1111-1111-1111-111111111111"]);
    expect(parsed.initialAgents).toEqual(["@scout"]);
    expect(parsed.draftHint).toBe("Requested by the owner in #general");
  });

  test("rejects a name that fails the CoForge channel rule", () => {
    expect(() =>
      channelCreateActionSchema.parse({ type: "channel:create", name: "Design Team" }),
    ).toThrow();
    expect(() =>
      channelCreateActionSchema.parse({ type: "channel:create", name: "-design" }),
    ).toThrow();
  });

  test("rejects more than 64 initialHumans", () => {
    expect(() =>
      channelCreateActionSchema.parse({
        type: "channel:create",
        name: "design",
        initialHumans: Array.from({ length: 65 }, (_, i) => `user-${i}`),
      }),
    ).toThrow();
  });
});

describe("agentCreateActionSchema", () => {
  test("accepts a minimal agent", () => {
    const parsed = agentCreateActionSchema.parse({ type: "agent:create", name: "scout" });
    expect(parsed.name).toBe("scout");
  });

  test("accepts suggestedComputer or requiredComputer independently", () => {
    expect(
      agentCreateActionSchema.parse({
        type: "agent:create",
        name: "scout",
        suggestedComputer: "@laptop",
      }).suggestedComputer,
    ).toBe("@laptop");
    expect(
      agentCreateActionSchema.parse({
        type: "agent:create",
        name: "scout",
        requiredComputer: "laptop",
      }).requiredComputer,
    ).toBe("laptop");
  });

  test("rejects a name that fails the CoForge Agent rule", () => {
    expect(() => agentCreateActionSchema.parse({ type: "agent:create", name: "Scout" })).toThrow();
    expect(() => agentCreateActionSchema.parse({ type: "agent:create", name: "-scout" })).toThrow();
  });

  test("never accepts runtime/model/reasoning fields", () => {
    const parsed = agentCreateActionSchema.parse({
      type: "agent:create",
      name: "scout",
      // Extra fields are not part of the contract; zod strips them silently (no runtime/model here).
      runtime: "claude-code",
      model: "opus",
    });
    expect(parsed).not.toHaveProperty("runtime");
    expect(parsed).not.toHaveProperty("model");
  });
});

describe("channelAddMemberActionSchema", () => {
  test("accepts a channel with humans and/or agents", () => {
    const parsed = channelAddMemberActionSchema.parse({
      type: "channel:add_member",
      channel: "#design",
      humans: ["@alice"],
      agents: ["@scout"],
    });
    expect(parsed.channel).toBe("#design");
  });

  test("schema alone allows an empty add_member (cross-field rule rejects it)", () => {
    const parsed = channelAddMemberActionSchema.parse({
      type: "channel:add_member",
      channel: "#design",
    });
    expect(parsed.humans).toBeUndefined();
    expect(parsed.agents).toBeUndefined();
  });
});

describe("actionCardActionSchema discriminated union", () => {
  test("dispatches on type for all three kinds", () => {
    expect(actionCardActionSchema.parse({ type: "channel:create", name: "design" }).type).toBe(
      "channel:create",
    );
    expect(actionCardActionSchema.parse({ type: "agent:create", name: "scout" }).type).toBe(
      "agent:create",
    );
    expect(
      actionCardActionSchema.parse({
        type: "channel:add_member",
        channel: "#design",
        humans: ["@alice"],
      }).type,
    ).toBe("channel:add_member");
  });

  test("rejects an unknown/integration kind", () => {
    expect(() =>
      actionCardActionSchema.parse({
        type: "integration:approve_agent_login",
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
      }),
    ).toThrow();
  });
});

describe("validateActionCardAction", () => {
  test("returns null for valid actions of all three kinds", () => {
    expect(
      validateActionCardAction(
        channelCreateActionSchema.parse({ type: "channel:create", name: "design" }),
      ),
    ).toBeNull();
    expect(
      validateActionCardAction(
        agentCreateActionSchema.parse({ type: "agent:create", name: "scout" }),
      ),
    ).toBeNull();
    expect(
      validateActionCardAction(
        channelAddMemberActionSchema.parse({
          type: "channel:add_member",
          channel: "#design",
          humans: ["@alice"],
        }),
      ),
    ).toBeNull();
  });

  test("rejects agent:create with both suggestedComputer and requiredComputer", () => {
    const action = agentCreateActionSchema.parse({
      type: "agent:create",
      name: "scout",
      suggestedComputer: "laptop",
      requiredComputer: "desktop",
    });
    expect(validateActionCardAction(action)).toBe(
      "agent:create must include only one of suggestedComputer or requiredComputer",
    );
  });

  test("rejects channel:add_member with neither humans nor agents", () => {
    const action = channelAddMemberActionSchema.parse({
      type: "channel:add_member",
      channel: "#design",
    });
    expect(validateActionCardAction(action)).toBe(
      "channel:add_member must include at least one human or agent",
    );
  });

  test("rejects channel:add_member with empty arrays for both", () => {
    const action = channelAddMemberActionSchema.parse({
      type: "channel:add_member",
      channel: "#design",
      humans: [],
      agents: [],
    });
    expect(validateActionCardAction(action)).toBe(
      "channel:add_member must include at least one human or agent",
    );
  });
});

describe("pageFillActionSchema", () => {
  test("keeps field names and drops a value", () => {
    const parsed = pageFillActionSchema.parse({
      type: "page:fill",
      prompt: "Sign in",
      fields: [
        { id: "username", label: "Username", input: "text", selector: "#user", value: "ada" },
        {
          id: "password",
          label: "Password",
          input: "password",
          selector: "input[type=password]",
          value: "secret",
        },
      ],
    });
    expect(parsed.fields).toEqual([
      { id: "username", label: "Username", input: "text", selector: "#user" },
      { id: "password", label: "Password", input: "password", selector: "input[type=password]" },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(validateActionCardAction(parsed)).toBeNull();
  });

  test("rejects a repeated field id", () => {
    const action = pageFillActionSchema.parse({
      type: "page:fill",
      fields: [
        { id: "password", label: "Password", input: "password", selector: "#a" },
        { id: "password", label: "Again", input: "password", selector: "#b" },
      ],
    });
    expect(validateActionCardAction(action)).toBe("page:fill field ids must be unique");
  });

  test("rejects a password field with no selector", () => {
    const parsed = actionCardActionSchema.safeParse({
      type: "page:fill",
      fields: [{ id: "password", label: "Password", input: "password" }],
    });
    expect(parsed.success).toBe(false);
  });
});

test("an Agent cannot prepare the server's app approval card", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: APP_GRANT_AGENT_CARD_KIND,
    requestId: "r-1",
    appKey: "acme-notes",
  });
  expect(parsed.success).toBe(false);
});
