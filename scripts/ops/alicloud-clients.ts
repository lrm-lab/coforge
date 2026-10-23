/**
 * The Alibaba Cloud DNS and CDN API clients (official SDKs: @alicloud/alidns20150109,
 * @alicloud/cdn20180510 over @alicloud/openapi-client). Credentials come from the
 * `@alicloud/credentials` default chain: in GitHub Actions an OIDC token file exchanged for STS.
 * A GitHub OIDC token lives only minutes, and a renewal run (and each acme.sh hook process) outlasts
 * that, so every client is built from a freshly requested token written to that file just before
 * the role is assumed, and a new Credential. An SDK error can echo request details, so callers see
 * only `describeSdkError`.
 */
import { writeFile } from "node:fs/promises";

import Alidns from "@alicloud/alidns20150109";
import Cdn from "@alicloud/cdn20180510";
import * as OpenApi from "@alicloud/openapi-client";
import Credential from "@alicloud/credentials";

const OIDC_AUDIENCE = "sts.aliyuncs.com";

/** The token from a GitHub OIDC response body; an absent or empty one is an error, never `null`. */
export function parseOidcToken(body: unknown): string {
  const value = (body as { value?: unknown } | null)?.value;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("GitHub returned no OIDC token");
  return value;
}

/** Requests a GitHub OIDC token for Alibaba Cloud STS, retrying transient failures. Returns
 * undefined outside GitHub Actions (no request URL), where the credential chain supplies its own. */
export async function requestOidcToken(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  attempts = 3,
): Promise<string | undefined> {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base) return undefined;
  if (!bearer) throw new Error("ACTIONS_ID_TOKEN_REQUEST_TOKEN is not set");
  const url = new URL(base);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `bearer ${bearer}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseOidcToken(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await Bun.sleep(attempt * 2_000);
    }
  }
  throw new Error(
    `could not request a GitHub OIDC token: ${lastError instanceof Error ? lastError.message : "failed"}`,
  );
}

/** Writes a fresh OIDC token to the credential chain's token file and masks it in the log. */
export async function refreshOidcToken(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const token = await requestOidcToken(env);
  if (!token) return;
  const file = env.ALIBABA_CLOUD_OIDC_TOKEN_FILE;
  if (!file) throw new Error("ALIBABA_CLOUD_OIDC_TOKEN_FILE is not set");
  // Masked before it is written anywhere. Both streams: acme.sh may capture a hook's stdout.
  process.stdout.write(`::add-mask::${token}\n`);
  process.stderr.write(`::add-mask::${token}\n`);
  await writeFile(file, token, { mode: 0o600 });
}

async function credentialConfig(endpoint: string): Promise<OpenApi.Config> {
  await refreshOidcToken();
  return new OpenApi.Config({ credential: new Credential(), endpoint });
}

export async function dnsClient(): Promise<Alidns> {
  return new Alidns(await credentialConfig("alidns.aliyuncs.com"));
}

export async function cdnClient(): Promise<Cdn> {
  return new Cdn(await credentialConfig("cdn.aliyuncs.com"));
}

/** The API error code of an SDK error, when it has one. */
export function sdkErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Only an API's code and request id: never the message, which may carry parameters. A failure
 * that never reached the API (network, credentials) has no code, so its error class stands in. */
export function describeSdkError(action: string, error: unknown): Error {
  const data = (error as { data?: { RequestId?: unknown } } | null)?.data;
  const requestId = typeof data?.RequestId === "string" ? data.RequestId : "unknown";
  const errorClass = error instanceof Error ? error.name : undefined;
  const code = sdkErrorCode(error) ?? errorClass ?? "unknown";
  return new Error(`${action} failed: code=${code} request-id=${requestId}`);
}
