import { expect, test } from "bun:test";
import {
  encodeAgentCredentialRestored,
  type AgentCredentialRestored,
} from "@lrm/coforge-sdk/internal";
import {
  agentCredentialRestoredMethods,
  createAgentCredentialRestoredMethod,
} from "#src/server/centrifugo/agent-credential-restored-receiver.server";

const report: AgentCredentialRestored = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  reason: "user_reauth",
  releaseCause: "model_output",
  restoredAtMs: 1_700_000_000_000,
};
const daemon = { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" };
const metadata = (principal: object) => ({ principal }) as never;

function subject(accepts = true) {
  const received: unknown[] = [];
  const method = createAgentCredentialRestoredMethod({
    receive: async (scope, value) => {
      received.push([scope, value.agentId]);
      return accepts;
    },
  });
  return { method, received };
}

test("a Computer's daemon report reaches the Agent of its own Workspace and Computer", async () => {
  const { method, received } = subject();
  const answer = await method(encodeAgentCredentialRestored(report), metadata(daemon));
  expect(answer).toEqual(new Uint8Array());
  expect(received).toEqual([[{ workspaceId: "workspace-1", computerId: "computer-1" }, "agent-1"]]);
});

test.each([
  ["a principal that is not a daemon", { ...daemon, agentId: "agent-1" }],
  ["another Workspace", { ...daemon, workspaceId: "workspace-2" }],
])("%s is refused", async (_name, principal) => {
  const { method, received } = subject();
  const answer = await method(encodeAgentCredentialRestored(report), metadata(principal));
  expect(answer).toMatchObject({ code: expect.any(Number) });
  expect(received).toEqual([]);
});

test("an Agent the Computer does not run, or a malformed report, is refused with 403", async () => {
  const unknownAgent = await subject(false).method(
    encodeAgentCredentialRestored(report),
    metadata(daemon),
  );
  expect(unknownAgent).toMatchObject({ code: 403 });
  const malformed = await subject().method(new Uint8Array([1, 2, 3]), metadata(daemon));
  expect(malformed).toMatchObject({ code: 403 });
});

test("without a database the method answers 503", async () => {
  const [method] = Object.values(agentCredentialRestoredMethods(null));
  expect(await method!(encodeAgentCredentialRestored(report), metadata(daemon))).toMatchObject({
    code: 503,
  });
});
