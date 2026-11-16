import {
  mintExternalAgentCredential,
  type ExternalAgentCredentialRepository,
  type ExternalCredentialMintRefusal,
  type ExternalMachine,
} from "#src/server/agents/external-agent-credentials.server";

export const EXTERNAL_DEVICE_CLIENT_ID = "coforge-cli";

export type ExternalAgentGrant = ExternalMachine & {
  kind: "external_agent";
  workspaceId: string;
  agentId: string;
};

export type ExternalGrantDetails = {
  kind: "external_agent";
  workspaceId: string;
  agentId: string;
  agent: { name: string; displayName: string };
  workspace: { name: string; slug: string };
  machine: ExternalMachine;
};

export type ExternalApprovalRefusal =
  | "not_authorized"
  | "agent_not_external"
  | "agent_unavailable"
  | "credential_limit";

export interface ExternalAgentDeviceDirectory {
  resolve(
    workspaceSlug: string,
    agentName: string,
  ): Promise<{ workspaceId: string; agentId: string; hosting: string } | undefined>;
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
}

export type ExternalAgentDeviceDeps = {
  directory: ExternalAgentDeviceDirectory;
  credentials: ExternalAgentCredentialRepository;
};

const MACHINE_FIELD_LIMITS = {
  machine_name: 100,
  hostname: 255,
  os: 100,
  client_name: 100,
} as const;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type ExternalAuthorizeRequest = {
  workspace: string;
  agent: string;
  machine: ExternalMachine;
};

function boundedField(body: URLSearchParams, name: string, max: number): string | undefined {
  const value = body.get(name)?.trim();
  return value && value.length <= max && !CONTROL_CHARACTER.test(value) ? value : undefined;
}

export function parseExternalAuthorizeBody(
  body: URLSearchParams,
): ExternalAuthorizeRequest | undefined {
  const workspace = boundedField(body, "workspace", 100);
  const agent = boundedField(body, "agent", 100);
  const machineName = boundedField(body, "machine_name", MACHINE_FIELD_LIMITS.machine_name);
  const hostname = boundedField(body, "hostname", MACHINE_FIELD_LIMITS.hostname);
  const os = boundedField(body, "os", MACHINE_FIELD_LIMITS.os);
  const clientName = boundedField(body, "client_name", MACHINE_FIELD_LIMITS.client_name);
  if (!workspace || !agent || !machineName || !hostname || !os || !clientName) return undefined;
  return { workspace, agent, machine: { machineName, hostname, os, clientName } };
}

/** Before sign-in nothing may tell an Agent that does not exist from one that runs on a Computer:
 * both are the same refusal, so a Workspace slug and a guessed name reveal nothing. */
export type ExternalGrantResolution = { ok: true; grant: ExternalAgentGrant } | { ok: false };

export async function resolveExternalAgentGrant(
  directory: Pick<ExternalAgentDeviceDirectory, "resolve">,
  request: ExternalAuthorizeRequest,
): Promise<ExternalGrantResolution> {
  const found = await directory.resolve(request.workspace, request.agent);
  if (!found || found.hosting !== "external") return { ok: false };
  return {
    ok: true,
    grant: {
      kind: "external_agent",
      workspaceId: found.workspaceId,
      agentId: found.agentId,
      ...request.machine,
    },
  };
}

export function readExternalAgentGrant(value: unknown): ExternalAgentGrant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const grant = value as Record<string, unknown>;
  const text = (key: string) => (typeof grant[key] === "string" ? (grant[key] as string) : "");
  const read = {
    kind: grant.kind,
    workspaceId: text("workspaceId"),
    agentId: text("agentId"),
    machineName: text("machineName"),
    hostname: text("hostname"),
    os: text("os"),
    clientName: text("clientName"),
  };
  if (read.kind !== "external_agent" || !read.workspaceId || !read.agentId) return undefined;
  return read as ExternalAgentGrant;
}

export async function externalGrantDetails(
  directory: Pick<ExternalAgentDeviceDirectory, "identity">,
  value: unknown,
): Promise<ExternalGrantDetails | undefined> {
  const grant = readExternalAgentGrant(value);
  if (!grant) return undefined;
  const identity = await directory.identity(grant.workspaceId, grant.agentId);
  if (!identity) return undefined;
  return {
    kind: "external_agent",
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    ...identity,
    machine: {
      machineName: grant.machineName,
      hostname: grant.hostname,
      os: grant.os,
      clientName: grant.clientName,
    },
  };
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
      coforgeCode?: ExternalCredentialMintRefusal | "agent_not_found";
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
  if (
    !grant ||
    record.approvedAgentId !== grant.agentId ||
    record.approvedWorkspaceId !== grant.workspaceId
  )
    return { status: "error", error: "invalid_grant" };
  const identity = await deps.directory.identity(grant.workspaceId, grant.agentId);
  if (!identity) return { status: "error", error: "access_denied", coforgeCode: "agent_not_found" };
  const minted = await mintExternalAgentCredential({
    repository: deps.credentials,
    agentId: grant.agentId,
    workspaceId: grant.workspaceId,
    approvedByUserId: record.userId,
    machine: {
      machineName: grant.machineName,
      hostname: grant.hostname,
      os: grant.os,
      clientName: grant.clientName,
    },
  });
  if (!minted.ok) return { status: "error", error: "access_denied", coforgeCode: minted.reason };
  return {
    status: "authorized_external_agent",
    credentialId: minted.credentialId,
    apiKey: minted.apiKey,
    agentId: grant.agentId,
    agentName: identity.agent.name,
    workspaceId: grant.workspaceId,
    workspaceSlug: identity.workspace.slug,
  };
}
