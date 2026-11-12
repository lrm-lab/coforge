import { agentApiRoutes, ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import { contentLengthRejected, badRequest, payloadTooLarge } from "./agent-proxy-body";
import { pathParam } from "./agent-proxy-paths";
import { decodePathParam } from "./agent-proxy-request-parsers";
import { forwardResponse } from "./agent-proxy-response";
import { defineRoute, type ProxyRoute } from "./agent-proxy-route";

/** The local proxy's artifact file routes: the bytes of one file, uploaded by sha256 before a push
 * names them and downloaded by path. The JSON artifact route stays with the proxy's own table. */

const FILES = agentApiRoutes.proxy.artifactFiles;
const UPLOAD_PREFIX = FILES.upload.path("");
const DOWNLOAD_PREFIX = `${agentApiRoutes.proxy.artifacts.path}/`;
const FILES_SEGMENT = "/files/";
const SHA256 = /^[0-9a-f]{64}$/;

/** `<artifact>/files/<path>`, each part still encoded; the artifact id never holds a `/`. */
function downloadParam(pathname: string): string | undefined {
  if (!pathname.startsWith(DOWNLOAD_PREFIX)) return undefined;
  const rest = pathname.slice(DOWNLOAD_PREFIX.length);
  const split = rest.indexOf(FILES_SEGMENT);
  return split > 0 && split + FILES_SEGMENT.length < rest.length ? rest : undefined;
}

export const ARTIFACT_FILE_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/artifact-upload",
    method: FILES.upload.method,
    match: pathParam(UPLOAD_PREFIX),
    body: "none",
    handler: "agentArtifactUpload",
    parse: ({ request, param }) => {
      const sha256 = decodePathParam(param);
      if (sha256 instanceof Response) return sha256;
      if (!SHA256.test(sha256)) return badRequest();
      // The bytes are forwarded as they arrive: only a declared length bounds them.
      if (!request.headers.get("content-length"))
        return new Response("length required", { status: 411 });
      if (contentLengthRejected(request, ARTIFACT_UPLOAD_MAX_BYTES, true)) return payloadTooLarge();
      return { sha256, request };
    },
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/artifact-download",
    method: FILES.download.method,
    match: downloadParam,
    body: "none",
    handler: "agentArtifactDownload",
    parse: ({ param, url }) => {
      const split = param.indexOf(FILES_SEGMENT);
      const artifact = decodePathParam(param.slice(0, split));
      const path = decodePathParam(param.slice(split + FILES_SEGMENT.length));
      if (artifact instanceof Response) return artifact;
      if (path instanceof Response) return path;
      const raw = url.searchParams.get("version");
      if (raw === null) return { artifact, path };
      const version = Number(raw);
      return /^\d+$/.test(raw) && Number.isSafeInteger(version)
        ? { artifact, path, version }
        : badRequest();
    },
    respond: forwardResponse,
  }),
];
