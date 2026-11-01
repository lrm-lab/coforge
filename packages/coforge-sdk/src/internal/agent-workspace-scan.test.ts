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
  withStatistics: false,
};

test("workspace scan request and result round trip a listing", () => {
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
        fileCount: 0,
        totalSizeBytes: 0,
        statisticsStatus: "" as const,
      },
    ],
  };
  expect(decodeAgentWorkspaceScanResult(encodeAgentWorkspaceScanResult(result))).toEqual(result);
});

test("workspace scan request and result round trip budgeted statistics", () => {
  const statisticsRequest = { ...request, withStatistics: true };
  expect(
    decodeAgentWorkspaceScanRequest(encodeAgentWorkspaceScanRequest(statisticsRequest)),
  ).toEqual(statisticsRequest);
  const result = {
    ...statisticsRequest,
    workspaces: [
      {
        agentId: "agent-a",
        status: "present" as const,
        rootPath: "/workspaces/agent-a",
        modifiedAtMs: 123,
        fileCount: 2,
        totalSizeBytes: 456,
        statisticsStatus: "complete" as const,
      },
      {
        agentId: "agent-b",
        status: "present" as const,
        rootPath: "/workspaces/agent-b",
        modifiedAtMs: 124,
        fileCount: 25_000,
        totalSizeBytes: 1_000_000,
        statisticsStatus: "truncated" as const,
      },
      {
        agentId: "agent-c",
        status: "present" as const,
        rootPath: "/workspaces/agent-c",
        modifiedAtMs: 125,
        fileCount: 0,
        totalSizeBytes: 0,
        statisticsStatus: "skipped" as const,
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
          fileCount: 0,
          totalSizeBytes: 0,
          statisticsStatus: "",
        },
      ],
    }),
  ).toThrow("Invalid Agent workspace scan entry");
});

test("workspace scan rejects an unknown statistics status", () => {
  expect(() =>
    encodeAgentWorkspaceScanResult({
      ...request,
      workspaces: [
        {
          agentId: "agent-a",
          status: "present",
          rootPath: "/workspaces/agent-a",
          modifiedAtMs: 0,
          fileCount: 1,
          totalSizeBytes: 1,
          statisticsStatus: "partial" as never,
        },
      ],
    }),
  ).toThrow("Invalid Agent workspace statistics status");
});
