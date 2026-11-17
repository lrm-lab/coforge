import { CliError } from "../cli-error";

export const EXTERNAL_CLIENT_ID = "coforge-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export type MachineIdentity = {
  machineName: string;
  hostname: string;
  os: string;
  clientName: string;
};

export type DeviceGrant = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type IssuedKey = {
  credentialId: string;
  apiKey: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  workspaceSlug: string;
};

export type TokenPoll =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "transient" }
  | { state: "authorized"; key: IssuedKey };

const DENIED: Record<string, string> = {
  not_authorized:
    "The person who approved this sign-in is not allowed to manage this Agent; an owner or admin of the Workspace must approve it.",
  agent_not_external:
    "This Agent is managed by a Computer, not an external Agent; it has no machine keys.",
  agent_unavailable: "This Agent is stopped or deleted, so it cannot sign in.",
  credential_limit:
    "This Agent already has the most machine keys it may hold; revoke one in the Agent's settings, then sign in again.",
  agent_not_found: "This Agent no longer exists in the Workspace.",
};

function failure(code: string, message: string, next?: string): CliError {
  return new CliError({ code, message, retryable: false, suggestedNextAction: next });
}

const RERUN = "Run `coforge agent login start` again.";

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json().catch(() => undefined);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function text(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value ? value : undefined;
}

function endpoint(serverUrl: string, path: string): URL {
  const url = new URL(serverUrl);
  url.pathname = path;
  url.search = "";
  return url;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15_000),
  };
}

export async function startDeviceGrant(
  fetchFn: FetchLike,
  serverUrl: string,
  request: { workspace: string; agent: string; machine: MachineIdentity },
): Promise<DeviceGrant> {
  let response: Response;
  try {
    response = await fetchFn(
      endpoint(serverUrl, "/oauth/device"),
      form({
        client_id: EXTERNAL_CLIENT_ID,
        workspace: request.workspace,
        agent: request.agent,
        machine_name: request.machine.machineName,
        hostname: request.machine.hostname,
        os: request.machine.os,
        client_name: request.machine.clientName,
      }),
    );
  } catch {
    throw failure("LOGIN_NETWORK_FAILED", `Could not reach ${new URL(serverUrl).origin}.`);
  }
  const body = await jsonOf(response);
  if (!response.ok) {
    const code = text(body, "coforge_code");
    if (code === "agent_not_found")
      throw failure(
        "AGENT_NOT_FOUND",
        `No Agent @${request.agent} in Workspace ${request.workspace}, or it is not visible to the approver.`,
      );
    if (code === "agent_not_external")
      throw failure("AGENT_NOT_EXTERNAL", DENIED.agent_not_external!);
    throw failure(
      "LOGIN_REFUSED",
      response.status >= 500
        ? "The server could not start the sign-in; try again shortly."
        : (text(body, "error_description") ??
            `The server refused the sign-in (HTTP ${response.status}).`),
    );
  }
  const deviceCode = text(body, "device_code");
  const userCode = text(body, "user_code");
  const verificationUri = text(body, "verification_uri");
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  if (!deviceCode || !userCode || !verificationUri || !(expiresIn > 0))
    throw failure("LOGIN_REFUSED", "The server's sign-in answer was not understood.");
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn,
    interval: interval > 0 ? interval : 5,
  };
}

/** One poll of the token endpoint. A terminal refusal throws; a network or 5xx failure is
 * `transient`, so the caller decides how long to keep trying. Response bodies are never echoed. */
export async function pollDeviceToken(
  fetchFn: FetchLike,
  serverUrl: string,
  deviceCode: string,
): Promise<TokenPoll> {
  let response: Response;
  try {
    response = await fetchFn(
      endpoint(serverUrl, "/oauth/token"),
      form({
        grant_type: DEVICE_GRANT_TYPE,
        client_id: EXTERNAL_CLIENT_ID,
        device_code: deviceCode,
      }),
    );
  } catch {
    return { state: "transient" };
  }
  const body = await jsonOf(response);
  if (response.ok) {
    const key = {
      credentialId: text(body, "credential_id"),
      apiKey: text(body, "api_key"),
      agentId: text(body, "agent_id"),
      agentName: text(body, "agent_name"),
      workspaceId: text(body, "workspace_id"),
      workspaceSlug: text(body, "workspace_slug"),
    };
    if (body.kind !== "external_agent" || Object.values(key).some((value) => !value))
      throw failure("LOGIN_REFUSED", "The server's sign-in answer was not understood.");
    return { state: "authorized", key: key as IssuedKey };
  }
  if (response.status >= 500) return { state: "transient" };
  const error = text(body, "error");
  if (error === "authorization_pending") return { state: "pending" };
  if (error === "slow_down") return { state: "slow_down" };
  if (error === "expired_token")
    throw failure("DEVICE_CODE_EXPIRED", "The sign-in code expired before it was approved.", RERUN);
  if (error === "access_denied") {
    const code = text(body, "coforge_code");
    const reason = code ? DENIED[code] : undefined;
    throw failure(
      code === "agent_not_found" ? "AGENT_NOT_FOUND" : "LOGIN_DENIED",
      reason ?? "The sign-in was denied.",
      code === "credential_limit" || code === "not_authorized" ? undefined : RERUN,
    );
  }
  throw failure("DEVICE_CODE_INVALID", "The sign-in code is no longer valid.", RERUN);
}
