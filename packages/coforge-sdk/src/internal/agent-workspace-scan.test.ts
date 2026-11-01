import { expect, test } from "bun:test";
import {
  decodeAgentWorkspaceScanResult,
  encodeAgentWorkspaceScanRequest,
  encodeAgentWorkspaceScanResult,
  decodeAgentWorkspaceScanRequest,
} from "./agent-workspace-scan";

const request = {
  protocolMajor: 1,
  requestId: "request-scan",
  workspaceId: "workspace",
  computerId: "computer",
};

test("workspace scan request and result round trip directory summaries", () => {
  expect(decodeAgentWorkspaceScanRequest(encodeAgentWorkspaceScanRequest(request))).toEqual(
    request,
  );
  const result = {
    ...request,
    workspaces: [
      {
        agentId: "agent-a",
        status: "present" as const,
        rootPath: "/workspaces/agent-a",
        modifiedAtMs: 123,
      },
    ],
  };
  expect(decodeAgentWorkspaceScanResult(encodeAgentWorkspaceScanResult(result))).toEqual(result);
});

test("workspace scan rejects an unsafe directory name", () => {
  expect(() =>
    encodeAgentWorkspaceScanResult({
      ...request,
      workspaces: [
        {
          agentId: "../other",
          status: "present",
          rootPath: "",
          modifiedAtMs: 0,
        },
      ],
    }),
  ).toThrow("Invalid Agent workspace scan entry");
});
