import { agentApiRoutes, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import {
  ARTIFACTS_DISABLED_MESSAGE,
  artifactRequest,
  type ArtifactTransport,
} from "#src/artifact-commands";
import { CliError } from "#src/cli-error";
import { readProxyErrorBody, requireProxySetup } from "#src/proxy-request";

/** One file of an artifact, to download: at `version`, or the current one. */
export type ArtifactFileRequest = { artifact: string; path: string; version?: number };

/** The artifact operations and file transfers of one Agent, through the daemon's proxy. */
export function artifactTransport(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Required<ArtifactTransport> {
  return {
    artifact: (request: AgentArtifactRequest) =>
      artifactRequest(proxyEndpoint, context, proxyUrl, request),
    artifactUpload: (sha256, bytes) =>
      artifactUploadRequest(proxyEndpoint, context, proxyUrl, sha256, bytes),
    artifactDownload: (request) =>
      artifactDownloadRequest(proxyEndpoint, context, proxyUrl, request),
  };
}

/** The bytes of a file a push named (`missing`), sent through the daemon's proxy as the Agent. The
 * same bytes sent again change nothing, so a failure on the way may simply be tried again. */
export async function artifactUploadRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  sha256: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  requireProxySetup("artifact", context, proxyUrl);
  const route = agentApiRoutes.proxy.artifactFiles.upload;
  const response = await send(
    () =>
      fetch(proxyEndpoint(route.path(sha256)), {
        method: route.method,
        headers: {
          authorization: `Bearer ${context}`,
          "content-type": "application/octet-stream",
        },
        body: bytes,
        signal: AbortSignal.timeout(120_000),
      }),
    "upload",
  );
  if (!response.ok) throw await refusal(response, "upload");
}

/** One file's bytes, exactly as the artifact holds them. */
export async function artifactDownloadRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  { artifact, path, version }: ArtifactFileRequest,
): Promise<Uint8Array> {
  requireProxySetup("artifact", context, proxyUrl);
  const route = agentApiRoutes.proxy.artifactFiles.download;
  const url = proxyEndpoint(route.path(artifact, path));
  if (version !== undefined) url.searchParams.set("version", String(version));
  const response = await send(
    () =>
      fetch(url, {
        method: route.method,
        headers: { authorization: `Bearer ${context}` },
        signal: AbortSignal.timeout(120_000),
      }),
    "download",
  );
  if (!response.ok) throw await refusal(response, "download");
  return new Uint8Array(await response.arrayBuffer());
}

async function send(request: () => Promise<Response>, what: string): Promise<Response> {
  try {
    return await request();
  } catch {
    throw new CliError({
      code: "ARTIFACT_FAILED",
      message: `artifact file ${what} failed (network or timeout)`,
      retryable: true,
    });
  }
}

async function refusal(response: Response, what: string): Promise<CliError> {
  const { json } = await readProxyErrorBody(response);
  const message = json?.error ?? `HTTP ${response.status}`;
  if (message.includes("(artifacts-disabled)"))
    return new CliError({
      code: "ARTIFACTS_DISABLED",
      message: ARTIFACTS_DISABLED_MESSAGE,
      retryable: false,
    });
  return new CliError({
    code: json?.code ?? (response.status === 404 ? "NOT_FOUND" : "ARTIFACT_FAILED"),
    message: `artifact file ${what} failed: ${message}`,
    retryable: json?.retryable ?? response.status >= 500,
    ...(json?.suggested_next_action ? { suggestedNextAction: json.suggested_next_action } : {}),
    ...(json?.proxy?.correlation_id ? { correlationId: json.proxy.correlation_id } : {}),
  });
}
