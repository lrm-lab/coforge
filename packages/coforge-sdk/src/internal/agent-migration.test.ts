import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentMigrationLeaseSchema } from "#src/internal/gen/coforge/rpc/v1/agent_migration_pb";
import {
  AGENT_MIGRATION_CANCEL_MESSAGE_TYPE,
  AGENT_MIGRATION_LEASE_MESSAGE_TYPE,
  decodeAgentMigrationCancel,
  decodeAgentMigrationLease,
  encodeAgentMigrationCancel,
  encodeAgentMigrationLease,
} from "./index";

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  migrationId: "migration-1",
  generation: 1,
  role: "source" as const,
};
const lease = { ...scope, expectedRevision: 0, expiresInMs: 3_600_000 };
const cancel = { ...scope, role: "target" as const, switched: false };

test("a lease and a cancel round-trip, each under its own discriminator", () => {
  expect(decodeAgentMigrationLease(encodeAgentMigrationLease(lease))).toEqual(lease);
  expect(decodeAgentMigrationCancel(encodeAgentMigrationCancel(cancel))).toEqual(cancel);
  expect(AGENT_MIGRATION_LEASE_MESSAGE_TYPE).toBe("coforge.rpc.v1.AgentMigrationLease");
  expect(AGENT_MIGRATION_CANCEL_MESSAGE_TYPE).toBe("coforge.rpc.v1.AgentMigrationCancel");
  // A cancel is never read as a lease, nor a lease as a cancel.
  expect(() => decodeAgentMigrationLease(encodeAgentMigrationCancel(cancel))).toThrow();
  expect(() => decodeAgentMigrationCancel(encodeAgentMigrationLease(lease))).toThrow();
});

test("a lease outside the protocol's bounds is refused on both sides of the wire", () => {
  for (const wrong of [
    { ...lease, protocolMajor: 2 },
    { ...lease, agentId: "../agent" },
    { ...lease, migrationId: "" },
    { ...lease, generation: 0 },
    { ...lease, expectedRevision: -1 },
    { ...lease, expiresInMs: 0 },
    { ...lease, expiresInMs: 25 * 3_600_000 },
    { ...lease, role: "bystander" as never },
  ])
    expect(() => encodeAgentMigrationLease(wrong)).toThrow();
  const unchecked = toBinary(
    AgentMigrationLeaseSchema,
    create(AgentMigrationLeaseSchema, {
      ...lease,
      generation: 0,
      messageType: AGENT_MIGRATION_LEASE_MESSAGE_TYPE,
    }),
  );
  expect(() => decodeAgentMigrationLease(unchecked)).toThrow();
  expect(() => decodeAgentMigrationLease(new Uint8Array(32_769))).toThrow();
});
