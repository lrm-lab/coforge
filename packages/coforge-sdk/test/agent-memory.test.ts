import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AgentMemoryRequestSchema } from "../src/internal/gen/coforge/rpc/v1/agent_memory_pb";
import {
  decodeAgentMemoryRequest,
  decodeAgentMemoryResult,
  encodeAgentMemoryRequest,
  encodeAgentMemoryResult,
} from "../src/internal/agent-memory";
const id = "00000000-0000-4000-8000-000000000001";
const scope = { requestId: id, workspaceId: id, computerId: id, agentId: id };
test("personal memory wire is versioned and validates paths and response budgets", () => {
  const request = {
    ...scope,
    command: { operation: "get" as const, key: "decision", revision: "a".repeat(64) },
  };
  expect(decodeAgentMemoryRequest(encodeAgentMemoryRequest(request))).toMatchObject(request);
  const result = { ...scope, status: "ok" as const, result: { entries: [] } };
  expect(decodeAgentMemoryResult(encodeAgentMemoryResult(result))).toEqual(result);
  expect(() => decodeAgentMemoryRequest(encodeAgentMemoryResult(result))).toThrow();
  expect(() =>
    encodeAgentMemoryRequest({ ...scope, command: { operation: "get", key: "../../other" } }),
  ).toThrow();
  expect(() =>
    decodeAgentMemoryRequest(
      toBinary(
        AgentMemoryRequestSchema,
        create(AgentMemoryRequestSchema, {
          ...scope,
          protocolMajor: 2,
          messageType: "coforge.rpc.v1.AgentMemoryRequest",
          commandJson: '{"operation":"list"}',
        }),
      ),
    ),
  ).toThrow();
  expect(() =>
    encodeAgentMemoryResult({
      ...scope,
      status: "ok",
      result: {
        entries: [
          {
            key: "large",
            title: "Large",
            content: "x".repeat(100000),
            source: "source",
            kind: "fact",
            applicability: "",
            status: "active",
            updatedAt: "",
            revision: "a".repeat(64),
            path: "notes/knowledge/large.md",
          },
        ],
      },
    }),
  ).toThrow();
});
