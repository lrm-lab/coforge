import {
  mintExternalAgentCredential,
  type ExternalAgentCredentialRepository,
  type ExternalCredentialMintRefusal,
  type ExternalMachine,
} from "#src/server/agents/external-agent-credentials.server";
import {
  EXTERNAL_MINT_REFUSAL,
  type ExternalMintRateLimits,
} from "#src/server/agents/external-agent-mint-rate-limit.server";

export const EXTERNAL_DEVICE_CLIENT_ID = "coforge-cli";

export type ExternalAgentGrant = {
  kind: "external_agent";
  machine: ExternalMachine;
};

export type ExternalGrantDetails = ExternalAgentGrant;

export type ApprovableExternalAgent = {
  agentId: string;
  name: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
};

export type ExternalApprovalRefusal =
  | "not_authorized"
  | "agent_not_external"
  | "agent_unavailable"
  | "credential_limit"
  | "agent_not_found"
  | "mint_rate_limited";

export interface ExternalAgentDeviceDirectory {
  target(agentId: string): Promise<{ workspaceId: string; hosting: string } | undefined>;
  identity(
    workspaceId: string,
    agentId: string,
  ): Promise<
    | { agent: { name: string; displayName: string }; workspace: { name: string; slug: string } }
    | undefined
  >;
  approvalRefusal(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
  }): Promise<ExternalApprovalRefusal | undefined>;
  approvable(userId: string): Promise<ApprovableExternalAgent[]>;
}

export type ExternalAgentDeviceDeps = {
  directory: ExternalAgentDeviceDirectory;
  credentials: ExternalAgentCredentialRepository;
  mintLimits: ExternalMintRateLimits;
};

const MACHINE_FIELD_LIMITS = {
  machine_name: 100,
  hostname: 255,
  os: 100,
  client_name: 100,
} as const;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type ExternalAuthorizeRequest = { machine: ExternalMachine };

function boundedField(body: URLSearchParams, name: string, max: number): string | undefined {
  const value = body.get(name)?.trim();
  return value && value.length <= max && !CONTROL_CHARACTER.test(value) ? value : undefined;
}

export function parseExternalAuthorizeBody(
  body: URLSearchParams,
): ExternalAuthorizeRequest | undefined {
  const machineName = boundedField(body, "machine_name", MACHINE_FIELD_LIMITS.machine_name);
  const hostname = boundedField(body, "hostname", MACHINE_FIELD_LIMITS.hostname);
  const os = boundedField(body, "os", MACHINE_FIELD_LIMITS.os);
  const clientName = boundedField(body, "client_name", MACHINE_FIELD_LIMITS.client_name);
  if (!machineName || !hostname || !os || !clientName) return undefined;
  return { machine: { machineName, hostname, os, clientName } };
}

export function externalGrantOf(request: ExternalAuthorizeRequest): ExternalAgentGrant {
  return { kind: "external_agent", machine: request.machine };
}

export function readExternalAgentGrant(value: unknown): ExternalAgentGrant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const grant = value as Record<string, unknown>;
  const text = (source: Record<string, unknown>, key: string) =>
    typeof source[key] === "string" ? (source[key] as string) : "";
  const machine =
    grant.machine && typeof grant.machine === "object"
      ? (grant.machine as Record<string, unknown>)
      : {};
  const read = {
    kind: grant.kind,
    machine: {
      machineName: text(machine, "machineName"),
      hostname: text(machine, "hostname"),
      os: text(machine, "os"),
      clientName: text(machine, "clientName"),
    },
  };
  if (read.kind !== "external_agent") return undefined;
  return read as ExternalAgentGrant;
}

export type ExternalAgentRedeemed =
  | {
      status: "authorized_external_agent";
      credentialId: string;
      apiKey: string;
      agentId: string;
      agentName: string;
      workspaceId: string;
      workspaceSlug: string;
    }
  | {
      status: "error";
      error: "access_denied" | "invalid_grant";
      coforgeCode?:
        | ExternalCredentialMintRefusal
        | typeof EXTERNAL_MINT_REFUSAL
        | "agent_not_found";
      retryAfterSeconds?: number;
    };

export async function redeemExternalAgentGrant(
  deps: ExternalAgentDeviceDeps,
  record: {
    userId: string | null;
    grant?: unknown;
    approvedAgentId?: string | null;
    approvedWorkspaceId?: string | null;
  },
): Promise<ExternalAgentRedeemed> {
  const grant = readExternalAgentGrant(record.grant);
  const { approvedAgentId: agentId, approvedWorkspaceId: workspaceId } = record;
  if (!grant || !agentId || !workspaceId) return { status: "error", error: "invalid_grant" };
  const identity = await deps.directory.identity(workspaceId, agentId);
  if (!identity) return { status: "error", error: "access_denied", coforgeCode: "agent_not_found" };
  const minted = await mintExternalAgentCredential({
    repository: deps.credentials,
    rateLimits: deps.mintLimits,
    agentId,
    workspaceId,
    approvedByUserId: record.userId,
    source: "device",
    machine: grant.machine,
  });
  if (!minted.ok)
    return {
      status: "error",
      error: "access_denied",
      coforgeCode: minted.reason,
      ...("retryAfterSeconds" in minted ? { retryAfterSeconds: minted.retryAfterSeconds } : {}),
    };
  return {
    status: "authorized_external_agent",
    credentialId: minted.credentialId,
    apiKey: minted.apiKey,
    agentId,
    agentName: identity.agent.name,
    workspaceId,
    workspaceSlug: identity.workspace.slug,
  };
}
