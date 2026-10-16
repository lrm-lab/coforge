import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { boundedPayload } from "./codec";
import { isScopeId } from "./scope-id";
import {
  AgentMigrationCancelSchema,
  AgentMigrationLeaseSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_migration_pb";

/**
 * The two server→daemon messages of an Agent migration, published on the daemon control channel:
 * the transfer lease for one role of one attempt, and the cancel that ends it. Steps and failures go
 * the other way over HTTPS (`/api/daemon/agent-migrations`), not here.
 */

export const AGENT_MIGRATION_LEASE_MESSAGE_TYPE = "coforge.rpc.v1.AgentMigrationLease" as const;
export const AGENT_MIGRATION_CANCEL_MESSAGE_TYPE = "coforge.rpc.v1.AgentMigrationCancel" as const;
/** A daemon that runs migrations says so in its ready, and is leased again on each one. */
export const AGENT_MIGRATION_CAPABILITY = "agent-migration:v1" as const;
/** The longest lease the server issues; a longer one is not one it sent. */
export const AGENT_MIGRATION_MAX_LEASE_MS = 24 * 60 * 60 * 1000;

const MAX_BYTES = 32_768;
const MAX_COUNTER = 2 ** 31 - 1;

export type AgentMigrationRole = "source" | "target";

type AgentMigrationScope = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  migrationId: string;
  generation: number;
  role: AgentMigrationRole;
};

export type AgentMigrationLease = AgentMigrationScope & {
  expectedRevision: number;
  expiresInMs: number;
};

export type AgentMigrationCancel = AgentMigrationScope & { switched: boolean };

const counter = (value: number, min: number, max = MAX_COUNTER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function scope(value: AgentMigrationScope): AgentMigrationScope {
  if (
    value.protocolMajor !== 1 ||
    !counter(value.generation, 1) ||
    (value.role !== "source" && value.role !== "target") ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId, value.migrationId].some(
      (id) => !isScopeId(id),
    )
  )
    throw new Error("Invalid Agent migration scope");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    migrationId: value.migrationId,
    generation: value.generation,
    role: value.role,
  };
}

function lease(value: AgentMigrationLease): AgentMigrationLease {
  if (
    !counter(value.expectedRevision, 0) ||
    !counter(value.expiresInMs, 1, AGENT_MIGRATION_MAX_LEASE_MS)
  )
    throw new Error("Invalid Agent migration lease");
  return {
    ...scope(value),
    expectedRevision: value.expectedRevision,
    expiresInMs: value.expiresInMs,
  };
}

function cancel(value: AgentMigrationCancel): AgentMigrationCancel {
  return { ...scope(value), switched: value.switched === true };
}

const bounded = (bytes: Uint8Array) => boundedPayload(bytes, MAX_BYTES, "Agent migration");

export function encodeAgentMigrationLease(value: AgentMigrationLease): Uint8Array {
  return bounded(
    toBinary(
      AgentMigrationLeaseSchema,
      create(AgentMigrationLeaseSchema, {
        ...lease(value),
        messageType: AGENT_MIGRATION_LEASE_MESSAGE_TYPE,
      }),
    ),
  );
}

export function decodeAgentMigrationLease(bytes: Uint8Array): AgentMigrationLease {
  const value = fromBinary(AgentMigrationLeaseSchema, bounded(bytes));
  if (value.messageType !== AGENT_MIGRATION_LEASE_MESSAGE_TYPE)
    throw new Error("Invalid Agent migration lease");
  return lease({ ...value, role: value.role as AgentMigrationRole });
}

export function encodeAgentMigrationCancel(value: AgentMigrationCancel): Uint8Array {
  return bounded(
    toBinary(
      AgentMigrationCancelSchema,
      create(AgentMigrationCancelSchema, {
        ...cancel(value),
        messageType: AGENT_MIGRATION_CANCEL_MESSAGE_TYPE,
      }),
    ),
  );
}

export function decodeAgentMigrationCancel(bytes: Uint8Array): AgentMigrationCancel {
  const value = fromBinary(AgentMigrationCancelSchema, bounded(bytes));
  if (value.messageType !== AGENT_MIGRATION_CANCEL_MESSAGE_TYPE)
    throw new Error("Invalid Agent migration cancel");
  return cancel({ ...value, role: value.role as AgentMigrationRole });
}
