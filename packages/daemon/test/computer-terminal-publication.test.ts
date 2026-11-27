import { expect, test } from "bun:test";
import {
  decodeTerminalControl,
  decodeTerminalFrame,
  COMPUTER_TERMINAL_FRAME_METHOD,
  encodeTerminalControl,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import {
  dispatchAgentPublication,
  type AgentPublicationDispatchDeps,
} from "#src/connection/agent-publication-dispatch";
import { DaemonQueries } from "#src/connection/daemon-queries";
import { ReadyPublicationHold } from "#src/connection/ready-publication-hold";
import { scanPublicationKinds } from "#src/connection/publication-routing";

const control = {
  protocolMajor: 1,
  workspaceId: "workspace",
  computerId: "computer",
  ownerUserId: "owner",
  sessionId: "shell",
  attachId: "attach",
  attachGeneration: 1,
  command: { case: "openOrAttach", value: { cols: 80, rows: 24, takeover: false } },
} as const;

test("terminal control is explicitly discriminated and the old structural shape is rejected", () => {
  const terminalBytes = encodeTerminalControl(control);
  expect(scanPublicationKinds(terminalBytes)).toEqual(["computer_terminal"]);
  expect(decodeTerminalControl(terminalBytes)).toEqual(control);

  const untagged = Uint8Array.from(
    Buffer.from(
      "08011209776f726b73706163651a08636f6d707574657222056f776e65722a057368656c6c320661747461636838015a0408501018",
      "hex",
    ),
  );
  expect(scanPublicationKinds(untagged)).toEqual([]);
  expect(() => decodeTerminalControl(untagged)).toThrow();

  const runtimeAuth = new TextEncoder().encode("coforge.rpc.v1.RuntimeAuthIntent");
  const unrelatedMarker = Uint8Array.of(...untagged, 0x42, runtimeAuth.length, ...runtimeAuth);
  expect(scanPublicationKinds(unrelatedMarker)).not.toContain("computer_terminal");
  expect(() => decodeTerminalControl(unrelatedMarker)).toThrow();
});

test("dispatches terminal only once ready and only within the authenticated Computer scope", async () => {
  const payload = encodeTerminalControl(control);
  const delivered: unknown[] = [];
  const sent: unknown[] = [];
  const queries = new DaemonQueries(async (method, bytes) => {
    sent.push({ method, frame: decodeTerminalFrame(bytes) });
  });
  queries.computerTerminal.onRequest(async (request) => {
    delivered.push(request);
  });
  const hold = new ReadyPublicationHold();
  const deps = { queries, readyPublications: hold } as AgentPublicationDispatchDeps;
  const config = { workspaceId: "workspace", computerId: "computer", startedAt: 1 };
  hold.hold();
  dispatchAgentPublication(deps, payload, config);
  expect(delivered).toEqual([]);
  hold.dispatch();
  dispatchAgentPublication(deps, payload, { ...config, computerId: "foreign" });
  const malformed = payload.slice();
  malformed[malformed.length - 1] = 0;
  expect(scanPublicationKinds(malformed)).toEqual(["computer_terminal"]);
  expect(() => decodeTerminalControl(malformed)).toThrow();
  dispatchAgentPublication(deps, malformed, config);
  dispatchAgentPublication(deps, payload, config);
  expect(delivered).toEqual([control]);

  const { command: _command, ...scope } = control;
  const frame = { ...scope, event: { case: "closed", value: { reason: "closed" } } } as const;
  await queries.computerTerminal.sendResult(frame);
  expect(sent).toEqual([{ method: COMPUTER_TERMINAL_FRAME_METHOD, frame }]);
});
