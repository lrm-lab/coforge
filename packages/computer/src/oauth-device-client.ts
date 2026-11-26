import { z } from "zod";
import type {
  AccessibleWorkspace,
  Credential,
  DeviceAuthorization,
  DeviceAuthorizationClient,
  TokenPollResult,
} from "./login";
import { CliError, loginError } from "./errors";

const nonEmptyString = z.string().min(1);
const positiveNumber = z.number().positive();
const optionalNonEmptyString = z.union([nonEmptyString, z.undefined()]).catch(undefined);
const optionalPositiveNumber = z.union([positiveNumber, z.undefined()]).catch(undefined);

const oauthMetadataSchema = z.looseObject({
  issuer: z.string(),
  device_authorization_endpoint: z.unknown().optional(),
  token_endpoint: z.unknown().optional(),
  coforge_workspaces_endpoint: z.unknown().optional(),
});

const deviceAuthorizationBodySchema = z.object({
  verification_uri: nonEmptyString,
  device_code: nonEmptyString,
  user_code: nonEmptyString,
  expires_in: positiveNumber,
  interval: positiveNumber.catch(5),
});

const tokenErrorBodySchema = z.object({
  error: nonEmptyString,
});

const tokenSuccessBodySchema = z.object({
  access_token: nonEmptyString,
  token_type: nonEmptyString,
  refresh_token: optionalNonEmptyString,
  expires_in: optionalPositiveNumber,
});

const workspaceSchema = z.object({
  id: nonEmptyString,
  slug: nonEmptyString,
  name: nonEmptyString,
});

type OAuthMetadata = z.infer<typeof oauthMetadataSchema>;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OAuthDeviceClient implements DeviceAuthorizationClient {
  readonly #fetch: Fetch;
  readonly #clientId: string;
  readonly #scope: string;
  #tokenEndpoint: string | null = null;

  constructor(input: { clientId: string; scope: string; fetch?: Fetch }) {
    this.#clientId = input.clientId;
    this.#scope = input.scope;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async authorize(serverUrl: string): Promise<DeviceAuthorization> {
    const issuer = normalizeServerUrl(serverUrl);
    const metadata = await this.#discover(issuer);
    const deviceAuthorizationEndpoint = normalizeEndpoint(
      metadata.device_authorization_endpoint,
      "device authorization endpoint",
    );
    this.#tokenEndpoint = normalizeEndpoint(metadata.token_endpoint, "token endpoint");

    const response = await this.#request(deviceAuthorizationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.#clientId, scope: this.#scope }),
    });
    const rawBody = await readJson(response, "device authorization");
    const body = parseRequiredFields(deviceAuthorizationBodySchema, rawBody);
    const verificationUri = normalizeEndpoint(body.verification_uri, "verification URI");
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri,
      expiresInSeconds: body.expires_in,
      intervalSeconds: body.interval,
    };
  }

  async pollToken(deviceCode: string, timeoutMilliseconds = 10_000): Promise<TokenPollResult> {
    if (!this.#tokenEndpoint) throw new Error("device authorization has not started");
    const response = await this.#pollRequest(this.#tokenEndpoint, timeoutMilliseconds, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.#clientId,
      }),
    });
    if (response === null) return { status: "network_timeout" };
    const rawBody = await readJson(response, "token polling", true);
    if (!response.ok) {
      const errorBody = parseRequiredFields(tokenErrorBodySchema, rawBody);
      if (errorBody.error === "authorization_pending") return { status: "pending" };
      if (errorBody.error === "slow_down") return { status: "slow_down" };
      if (errorBody.error === "access_denied") {
        throw loginError("AUTH_DEVICE_CODE_CANCELLED", "Device authorization was cancelled.");
      }
      if (errorBody.error === "expired_token") {
        throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
      }
      throw new Error(`device authorization failed: ${errorBody.error}`);
    }
    const body = parseRequiredFields(tokenSuccessBodySchema, rawBody);
    const credential: Credential = {
      accessToken: body.access_token,
      tokenType: body.token_type,
    };
    if (body.refresh_token) credential.refreshToken = body.refresh_token;
    if (body.expires_in) credential.expiresInSeconds = body.expires_in;
    return { status: "authorized", credential };
  }

  async getWorkspaceForServer(
    serverUrl: string,
    credential: Credential,
    workspaceSlug: string,
  ): Promise<AccessibleWorkspace> {
    const issuer = normalizeServerUrl(serverUrl);
    const metadata = await this.#discover(issuer);
    if (metadata.coforge_workspaces_endpoint === undefined)
      throw loginError("AUTH_WORKSPACE_GET_FAILED", "CoForge Workspace lookup is unavailable.");
    const endpoint = normalizeEndpoint(metadata.coforge_workspaces_endpoint, "Workspace endpoint");
    const workspaceEndpoint = new URL(
      `${encodeURIComponent(workspaceSlug)}/`,
      endpoint.endsWith("/") ? endpoint : `${endpoint}/`,
    ).toString();
    const response = await this.#request(workspaceEndpoint, {
      headers: { authorization: `${credential.tokenType} ${credential.accessToken}` },
    });
    if (!response.ok) {
      throw loginError(
        "AUTH_WORKSPACE_GET_FAILED",
        `Could not access Workspace '${workspaceSlug}' (HTTP ${response.status}).`,
      );
    }
    try {
      const body = (await response.json()) as { workspace?: unknown };
      return readWorkspace(body.workspace ?? body);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw loginError("AUTH_WORKSPACE_GET_FAILED", "The Workspace response is invalid.");
    }
  }

  async #discover(issuer: string): Promise<OAuthMetadata> {
    const discoveryResponse = await this.#request(discoveryUrl(issuer));
    const parsed = oauthMetadataSchema.safeParse(
      await readJson(discoveryResponse, "OAuth discovery"),
    );
    if (!parsed.success || parsed.data.issuer !== issuer)
      throw new Error("OAuth discovery issuer mismatch");
    return parsed.data;
  }

  async #request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(input, init);
    } catch (error) {
      throw loginError("AUTH_NETWORK_ERROR", "Could not reach the CoForge server.", {
        cause: error,
      });
    }
  }

  async #pollRequest(
    input: RequestInfo | URL,
    timeoutMilliseconds: number,
    init: RequestInit,
  ): Promise<Response | null> {
    try {
      return await this.#fetch(input, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, timeoutMilliseconds)),
      });
    } catch (error) {
      if (isRequestTimeout(error)) return null;
      throw loginError("AUTH_NETWORK_ERROR", "Could not reach the CoForge server.", {
        cause: error,
      });
    }
  }
}

function readWorkspace(value: unknown): AccessibleWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw loginError("AUTH_WORKSPACE_LIST_FAILED", "The Workspace list response is invalid.");
  }
  return parseRequiredFields(workspaceSchema, value);
}

function isSecureOrLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidServer("server URL is invalid");
  }
  if (!isSecureOrLoopbackUrl(url)) {
    throw invalidServer("server URL must use HTTPS");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw invalidServer("server URL must not contain credentials, query, or fragment");
  }
  return url.href.replace(/\/$/, "");
}

function discoveryUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return url.href;
}

function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function invalidServer(message: string): CliError {
  return new CliError(
    "AUTH_INVALID_SERVER",
    message,
    "Use an HTTPS server URL without credentials, query parameters, or a fragment.",
  );
}

function normalizeEndpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is missing`);
  const url = new URL(value);
  if (!isSecureOrLoopbackUrl(url)) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  return url.href;
}

async function readJson(response: Response, name: string, allowError = false): Promise<unknown> {
  const body: unknown = await response.json();
  if (!allowError && !response.ok) throw new Error(`${name} failed with HTTP ${response.status}`);
  return body;
}

function parseRequiredFields<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new Error(`${field !== undefined ? String(field) : "response"} is missing`);
  }
  return parsed.data;
}
