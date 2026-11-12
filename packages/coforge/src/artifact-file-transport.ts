import { agentApiRoutes, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { artifactNetworkFailure, artifactRefusal, type ArtifactCall } from "#src/artifact-failure";
import { artifactRequest, type ArtifactTransport } from "#src/artifact-commands";
import { requireProxySetup } from "#src/proxy-request";

/** How long one file's bytes may take, either way. */
const FILE_TRANSFER_TIMEOUT_MS = 120_000;

/** The artifact operations and file transfers of one Agent, through the daemon's proxy. */
export function artifactTransport(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Required<ArtifactTransport> {
  // Bytes go by their hash, so the same bytes sent again change nothing: a failure on the way
  // may simply be tried again.
  const transfer = async (what: "upload" | "download", request: () => Promise<Response>) => {
    requireProxySetup("artifact", context, proxyUrl);
    const call: ArtifactCall = {
      label: `artifact file ${what}`,
      writes: false,
      missingIs404: true,
    };
    let response: Response;
    try {
      response = await request();
    } catch {
      throw artifactNetworkFailure(`${call.label} failed (network or timeout)`, call);
    }
    if (!response.ok) throw await artifactRefusal(response, call);
    return response;
  };
  return {
    artifact: (request: AgentArtifactRequest) =>
      artifactRequest(proxyEndpoint, context, proxyUrl, request),
    // The bytes of a file a push named (`missing`), sent as the Agent.
    artifactUpload: async (sha256, bytes) => {
      const route = agentApiRoutes.proxy.artifactFiles.upload;
      await transfer("upload", () =>
        fetch(proxyEndpoint(route.path(sha256)), {
          method: route.method,
          headers: {
            authorization: `Bearer ${context}`,
            "content-type": "application/octet-stream",
          },
          body: bytes,
          signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
        }),
      );
    },
    // One file's bytes, exactly as the artifact holds them.
    artifactDownload: async ({ artifact, path, version }) => {
      const route = agentApiRoutes.proxy.artifactFiles.download;
      const url = proxyEndpoint(route.path(artifact, path));
      if (version !== undefined) url.searchParams.set("version", String(version));
      const response = await transfer("download", () =>
        fetch(url, {
          method: route.method,
          headers: { authorization: `Bearer ${context}` },
          signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
        }),
      );
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
