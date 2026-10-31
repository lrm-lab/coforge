import { describe, expect, test } from "bun:test";
import {
  agentDirectKey,
  agentPeerDirectKey,
  agentPeerOf,
  isAgentPeerDirectKey,
  isPeopleDirectKey,
  peopleDirectPeerId,
} from "#src/features/conversations/direct-key";
import {
  humanUsernameTarget,
  parsePeerTarget,
} from "#src/server/db/repositories/agent-peer-target.server";

describe("an Agent-to-Agent direct key", () => {
  test("is the same from either seat and names the other Agent", () => {
    expect(agentPeerDirectKey("b", "a")).toBe("agent:a|agent:b");
    expect(agentPeerDirectKey("a", "b")).toBe("agent:a|agent:b");
    expect(agentPeerOf("agent:a|agent:b", "a")).toBe("b");
    expect(agentPeerOf("agent:a|agent:b", "b")).toBe("a");
    expect(agentPeerOf("agent:a|agent:b", "c")).toBeUndefined();
  });

  test("is no people key and no person-and-Agent key", () => {
    const key = agentPeerDirectKey("a", "b");
    expect(isAgentPeerDirectKey(key)).toBe(true);
    expect(isPeopleDirectKey(key)).toBe(false);
    expect(peopleDirectPeerId(key, "a")).toBeUndefined();
    expect(isAgentPeerDirectKey(agentDirectKey("u", "a"))).toBe(false);
    expect(agentPeerOf(agentDirectKey("u", "a"), "a")).toBeUndefined();
    expect(agentPeerOf(null, "a")).toBeUndefined();
  });
});

describe("parsePeerTarget", () => {
  test("reads a bare handle and either suffix", () => {
    expect(parsePeerTarget("@ada")).toEqual({ name: "ada", kind: null });
    expect(parsePeerTarget("@ada~agent")).toEqual({ name: "ada", kind: "agent" });
    expect(parsePeerTarget("@ada~human")).toEqual({ name: "ada", kind: "human" });
  });

  test("refuses anything else as an invalid target", () => {
    for (const target of ["ada", "@", "@~agent", "@ada~bot", "@ada~", "@ada~agent~human", "#ada"])
      expect(() => parsePeerTarget(target)).toThrow("INVALID_TARGET");
  });
});

describe("humanUsernameTarget", () => {
  test("drops ~human and refuses ~agent", () => {
    expect(humanUsernameTarget("@ada")).toBe("@ada");
    expect(humanUsernameTarget("@ada~human")).toBe("@ada");
    expect(() => humanUsernameTarget("@ada~agent")).toThrow("INVALID_TARGET");
  });
});
