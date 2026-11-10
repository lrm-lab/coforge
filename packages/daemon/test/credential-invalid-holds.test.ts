import { expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@coforge/agent";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import {
  CredentialInvalidHolds,
  type CredentialRestored,
} from "#src/daemon-runtime/credential-invalid-holds";
import { credentialKeyOf } from "#src/daemon-runtime/credential-invalid-ledger";

const claude = (changes: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig => ({
  provider: "claude-code",
  model: "opus",
  reasoning: "balanced",
  ...changes,
});

/** Three running Agents (`a`, `b` on the shared Claude login, `c` with its own key) and what the
 * holds did to them. */
function subject(
  configs: Record<string, AgentRuntimeConfig> = {},
  onRestored: (report: CredentialRestored) => void = () => {},
) {
  const all: Record<string, AgentRuntimeConfig> = {
    a: claude(),
    b: claude(),
    c: claude({ envVars: { ANTHROPIC_AUTH_TOKEN: "own" } }),
    ...configs,
  };
  const running = new Set(Object.keys(all));
  const gate = new AgentDeliveryGate();
  const log = {
    present: [] as string[],
    wake: [] as string[],
    notices: [] as Array<[string, string | undefined]>,
    restored: [] as CredentialRestored[],
  };
  const holds = new CredentialInvalidHolds(
    {
      deliveryGate: gate,
      hold: (agentId) => {
        gate.hold(agentId, "credential_invalid");
        return true;
      },
      runningAgentIds: () => [...running],
      isRunning: (agentId) => running.has(agentId),
      configOf: (agentId) => all[agentId],
      present: (agentId) => void log.present.push(agentId),
      wake: (agentId) => void log.wake.push(agentId),
      notice: (agentId, text) => void log.notices.push([agentId, text]),
      noticeText: (_config, reason) => `notice ${reason}`,
      launchId: (agentId) => `launch-${agentId}`,
      restored: (report) => {
        log.restored.push(report);
        onRestored(report);
      },
    },
    1000,
  );
  return { holds, gate, log, running, all };
}

const held = (s: ReturnType<typeof subject>) =>
  ["a", "b", "c"].filter((agentId) => s.holds.isHeld(agentId));

test("a failure on the shared login holds every running Agent on it, and shows the others a notice", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  expect(held(s)).toEqual(["a", "b"]);
  expect(s.log.notices).toEqual([["b", "notice user_reauth"]]);
});

test("an Agent with credentials of its own is neither held by the shared login nor holds others", () => {
  const s = subject();
  s.holds.record("c", s.all.c!, "user_reauth");
  expect(held(s)).toEqual(["c"]);
  expect(credentialKeyOf("c", s.all.c!)).toBe("agent:c");
  expect(s.log.notices).toEqual([]);
});

test("a plan that lacks one model holds only the Agents on it", () => {
  const s = subject({ b: claude({ model: "sonnet" }) });
  s.holds.record("a", s.all.a!, "user_model_access");
  expect(held(s)).toEqual(["a"]);
});

test("a sign-in that changes ends the record: live Agents are told what they kept, and each Agent that showed it is reported", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.holds.credentialsChanged("shared:claude-code");
  expect(held(s)).toEqual([]);
  expect(s.log.present.sort()).toEqual(["a", "b"]);
  expect(s.log.notices.at(-1)).toEqual(["b", undefined]);
  expect(s.log.restored).toEqual([
    {
      agentId: "a",
      reason: "user_reauth",
      releaseCause: "credentials_changed",
      launchId: "launch-a",
      restoredAtMs: expect.any(Number),
    },
    {
      agentId: "b",
      reason: "user_reauth",
      releaseCause: "credentials_changed",
      launchId: "launch-b",
      restoredAtMs: expect.any(Number),
    },
  ]);
});

test("a closed Agent is started when its credential works again", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.running.delete("b");
  s.holds.credentialsChanged("shared:claude-code");
  expect(s.log.wake).toEqual(["b"]);
  expect(s.log.present).toEqual(["a"]);
});

test("a Stop ends the records of the Agent's sign-in, so the Agents on it are told what they kept", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.holds.stopped("a");
  s.gate.clearAgent("a");
  expect(held(s)).toEqual([]);
  expect(s.log.present).toEqual(["b"]);
  expect(s.log.restored.map((each) => each.releaseCause)).toEqual([
    "explicit_stop",
    "explicit_stop",
  ]);
});

test("model output ends the record only for a turn begun after it", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  const recordedAt = Date.now();
  s.holds.modelOutput("a", recordedAt - 1);
  expect(held(s)).toEqual(["a", "b"]);
  s.holds.modelOutput("a", Date.now() + 1);
  expect(held(s)).toEqual([]);
  expect(s.log.restored.map((each) => each.releaseCause)).toEqual(["model_output", "model_output"]);
});

test("a new model ends a plan record on the Agent's own key, and only stops holding an Agent on the shared login", () => {
  const own = subject({ a: claude({ envVars: { ANTHROPIC_AUTH_TOKEN: "own" } }) });
  own.holds.record("a", own.all.a!, "user_model_access");
  own.holds.modelChanged("a", "sonnet");
  expect(held(own)).toEqual([]);

  const shared = subject();
  shared.holds.record("a", shared.all.a!, "user_model_access");
  shared.all.a = claude({ model: "sonnet" });
  shared.holds.modelChanged("a", "sonnet");
  expect(held(shared)).toEqual(["b"]);
  expect(shared.log.restored).toEqual([]);
  expect(shared.holds.ledger.hasInvalid("shared:claude-code")).toBe(true);
});

test("a closed held Agent probes the credential after the hour: its hold ends and it is started", async () => {
  const s = subject();
  s.holds.record("c", s.all.c!, "user_reauth");
  s.holds.closed("c");
  await Bun.sleep(1100);
  expect(s.holds.isHeld("c")).toBe(false);
  expect(s.log.wake).toEqual(["c"]);
  s.holds.dispose();
});

test("a newer record of a kind replaces the older and keeps who showed it", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.holds.record("b", s.all.b!, "user_reauth");
  s.holds.credentialsChanged("shared:claude-code");
  expect(s.log.restored.map((each) => each.agentId).sort()).toEqual(["a", "b"]);
});

test("a login that signed in ends the shared record, but not an Agent's own", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.holds.record("c", s.all.c!, "user_reauth");
  s.holds.signedIn("claude-code");
  expect(held(s)).toEqual(["c"]);
});

test("a hold that is no longer the credential's is left alone when the record ends", () => {
  const s = subject();
  s.holds.record("a", s.all.a!, "user_reauth");
  s.gate.hold("a", "fingerprint_fence");
  s.holds.credentialsChanged("shared:claude-code");
  expect(s.gate.explicitHold("a")).toBe("fingerprint_fence");
  expect(s.log.present).toEqual(["b"]);
});

test("a closed Agent's probe timer leaves a hold that replaced the credential's", async () => {
  const s = subject();
  s.holds.record("c", s.all.c!, "user_reauth");
  s.holds.closed("c");
  s.gate.hold("c", "fingerprint_fence");
  await Bun.sleep(1100);
  expect(s.gate.explicitHold("c")).toBe("fingerprint_fence");
  expect(s.log.wake).toEqual([]);
  s.holds.dispose();
});

test("a failing report does not strand the other Agents the record held", () => {
  const s = subject({}, () => {
    throw new Error("the report could not be sent");
  });
  s.holds.record("a", s.all.a!, "user_reauth");
  s.holds.credentialsChanged("shared:claude-code");
  expect(held(s)).toEqual([]);
  expect(s.log.present.sort()).toEqual(["a", "b"]);
});

test("forgetting an Agent ends the record of its own credentials", () => {
  const s = subject();
  s.holds.record("c", s.all.c!, "user_reauth");
  s.holds.forget("c");
  expect(s.holds.ledger.hasInvalid("agent:c")).toBe(false);
});
