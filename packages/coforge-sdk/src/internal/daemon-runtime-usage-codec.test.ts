import { expect, test } from "bun:test";
import {
  RUNTIME_PROVIDER,
  USAGE_SCAN_MESSAGE_TYPE,
  USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
  decodeDaemonRuntimeUsageScanRequest,
  decodeDaemonRuntimeUsageScanResponse,
  encodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
} from "./index";

const scope = {
  protocolMajor: 1,
  requestId: "scan-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  provider: RUNTIME_PROVIDER.CODEX,
};

test("round trips an Agent usage scope and keeps zero revision distinct from absence", () => {
  const request = { ...scope, agentId: "agent-1", expectedRuntimeConfigRevision: 0 };
  expect(decodeDaemonRuntimeUsageScanRequest(encodeDaemonRuntimeUsageScanRequest(request))).toEqual(
    {
      ...request,
      messageType: USAGE_SCAN_MESSAGE_TYPE,
    },
  );
  const response = {
    ...scope,
    agentId: "agent-1",
    effectiveRuntimeConfigRevision: 0,
    status: "available",
    accepted: true,
  };
  expect(
    decodeDaemonRuntimeUsageScanResponse(encodeDaemonRuntimeUsageScanResponse(response)),
  ).toMatchObject({ ...response, messageType: USAGE_SCAN_RESPONSE_MESSAGE_TYPE });
});

test("keeps the existing Computer usage wire shape", () => {
  const request = decodeDaemonRuntimeUsageScanRequest(encodeDaemonRuntimeUsageScanRequest(scope));
  expect(request).toEqual({ ...scope, messageType: USAGE_SCAN_MESSAGE_TYPE });
  const response = { ...scope, status: "unavailable", accepted: false };
  const reading = decodeDaemonRuntimeUsageScanResponse(
    encodeDaemonRuntimeUsageScanResponse(response),
  );
  expect(reading).not.toHaveProperty("agentId");
  expect(reading).not.toHaveProperty("effectiveRuntimeConfigRevision");
  expect(reading).toMatchObject({ ...response, messageType: USAGE_SCAN_RESPONSE_MESSAGE_TYPE });
});

test("refuses bare and invalid Agent usage scopes before encoding", () => {
  expect(() => encodeDaemonRuntimeUsageScanRequest({ ...scope, agentId: "agent-1" })).toThrow();
  expect(() =>
    encodeDaemonRuntimeUsageScanRequest({
      ...scope,
      agentId: "agent-1",
      expectedRuntimeConfigRevision: -1,
    }),
  ).toThrow();
  expect(() =>
    encodeDaemonRuntimeUsageScanResponse({
      ...scope,
      effectiveRuntimeConfigRevision: 0,
      accepted: false,
      status: "unavailable",
    }),
  ).toThrow();
});
