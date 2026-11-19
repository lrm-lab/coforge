import type { ArtifactPathKind } from "#src/features/artifacts/artifact-path-kind";
import { publicArtifactPath } from "#src/features/artifacts/artifact-short-id";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { NO_RATE_LIMIT } from "#src/server/app-rate-limits/app-rate-limit.server";
import { clientAddress } from "#src/server/http/public-origin.server";
import { artifactContentType } from "./artifact-content-types.server";
import {
  publicFileDrawn,
  publicImagePage,
  publicNoPreviewPage,
  publicTextPage,
} from "./artifact-public-files.server";
import { publicMarkdownResponse } from "./artifact-public-markdown.server";
import type { PublicPage } from "./artifact-public-page.server";
import {
  ARTIFACT_HTML_LIMIT,
  fileRequestUse,
  isPageFile,
  pageFileResponse,
  PUBLIC_FILE_CACHE,
  type FileRequestUse,
} from "./artifact-sandbox-files.server";
import { decodeSandboxFilePath, sandboxFileUrlPath } from "./artifact-sandbox-path.server";
import {
  sandboxAssetResponse,
  sandboxRedirect,
  sandboxRefusal,
} from "./artifact-sandbox-response.server";
import type { ArtifactHost, SandboxDependencies } from "./artifact-sandbox.server";

export type PublicServingDependencies = Pick<
  SandboxDependencies,
  | "readBlob"
  | "publicPage"
  | "linkPage"
  | "missGuard"
  | "linkArtifactLimit"
  | "appOrigin"
  | "publicRateLimit"
  | "publicFileRateLimit"
  | "publicClientAddress"
>;

type PublicRef = {
  base: string;
  load(path?: string): Promise<{ page: PublicPage | null; miss: boolean }>;
  guarded: boolean;
};

export class ArtifactPublicServing {
  constructor(private readonly deps: PublicServingDependencies) {}

  serveLink(request: Request, host: ArtifactHost, raw?: string): Promise<Response> {
    return this.servePublicPage(request, host, this.linkRef(host), raw);
  }

  serveLinkFile(request: Request, host: ArtifactHost, raw: string): Promise<Response> {
    return this.servePublicFileOf(request, host, this.linkRef(host), raw);
  }

  private linkRef(host: ArtifactHost): PublicRef | null {
    const linkPage = this.deps.linkPage;
    return linkPage
      ? {
          base: "/l",
          load: async (path) => {
            const { shared, page } = await linkPage(host.artifactId, path);
            return { page, miss: !shared };
          },
          guarded: true,
        }
      : null;
  }

  private tokenRef(token: string): PublicRef | null {
    const publicPage = this.deps.publicPage;
    return publicPage
      ? {
          base: `/p/${token}`,
          load: async (path) => ({ page: await publicPage(token, path), miss: false }),
          guarded: false,
        }
      : null;
  }

  servePublic(
    request: Request,
    host: ArtifactHost,
    token: string,
    raw?: string,
  ): Promise<Response> {
    return this.servePublicPage(request, host, this.tokenRef(token), raw);
  }

  servePublicFile(
    request: Request,
    host: ArtifactHost,
    token: string,
    raw: string,
  ): Promise<Response> {
    return this.servePublicFileOf(request, host, this.tokenRef(token), raw);
  }

  private async loadPublic(
    request: Request,
    ref: PublicRef,
    path: string | undefined,
    artifactId?: string,
  ): Promise<PublicPage | Response | null> {
    const client = (this.deps.publicClientAddress ?? clientAddress)(request);
    const guard = ref.guarded ? this.deps.missGuard : undefined;
    const refusal = await guard?.refusal(client);
    if (refusal) {
      const response = sandboxRefusal(429, "Too many requests.");
      response.headers.set("Retry-After", String(refusal.retryAfterSeconds));
      return response;
    }
    const { page, miss } = await ref.load(path);
    if (miss) await guard?.miss(client);
    if (page && artifactId && ref.guarded) {
      const crowd = await (this.deps.linkArtifactLimit ?? NO_RATE_LIMIT).admit(artifactId);
      if (!crowd.allowed) {
        const response = sandboxRefusal(429, "Too many requests.");
        response.headers.set("Retry-After", String(crowd.retryAfterSeconds));
        return response;
      }
    }
    return page;
  }

  private async servePublicPage(
    request: Request,
    host: ArtifactHost,
    ref: PublicRef | null,
    raw?: string,
  ): Promise<Response> {
    if (!ref) return sandboxRefusal(404, "Not found.");
    const path = raw === undefined ? undefined : decodeSandboxFilePath(raw);
    const use = path === undefined ? null : fileRequestUse(request.headers);
    if (path === null || (path !== undefined && (!use || !publicUseAllowed(path, use))))
      return sandboxRefusal(404, "Not found.");
    const refused = await this.admitPublic(request, use);
    if (refused) return refused;
    const loaded = await this.loadPublic(
      request,
      ref,
      path,
      use === "frame" ? host.artifactId : undefined,
    );
    if (loaded instanceof Response) return loaded;
    const page = loaded;
    if (!page || page.artifactId !== host.artifactId) return sandboxRefusal(404, "Not found.");
    if (!ref.guarded && page.access === "link") return this.redirectToApp(page, path);
    if (path === undefined)
      return sandboxRedirect(
        `${ref.base}/${publicPageKind(page.kind) ? "page" : "file"}/${sandboxFileUrlPath(page.entryPath)}`,
      );
    if (
      !publicPageKind(page.kind) ||
      (page.kind === "markdown" && (path !== page.entryPath || use !== "frame"))
    )
      return sandboxRefusal(404, "Not found.");
    const bytes = await this.deps.readBlob(page.workspaceId, page.sha256);
    return (
      (page.kind === "markdown"
        ? publicMarkdownResponse({
            method: request.method,
            title: page.title,
            bytes,
            limit: ARTIFACT_HTML_LIMIT,
            frameAncestor: this.frameAncestorOf(ref),
          })
        : pageFileResponse({
            method: request.method,
            path,
            bytes,
            use: use!,
            pageOrigin: host.pageOrigin,
            frameAncestor: this.frameAncestorOf(ref),
            hostOrigin: null,
            filePrefix: `${host.pageOrigin}${ref.base}/page/`,
            fileCache: PUBLIC_FILE_CACHE,
          })) ?? sandboxRefusal(404, "Not found.")
    );
  }

  private frameAncestorOf(ref: PublicRef): string {
    return (ref.guarded && this.deps.appOrigin?.()) || "'none'";
  }

  private async admitPublic(
    request: Request,
    use: FileRequestUse | null,
  ): Promise<Response | null> {
    const limit =
      use === "subresource"
        ? (this.deps.publicFileRateLimit ?? this.deps.publicRateLimit)
        : this.deps.publicRateLimit;
    const admitted = await (limit ?? NO_RATE_LIMIT).admit(
      (this.deps.publicClientAddress ?? clientAddress)(request) ?? "unknown",
    );
    if (admitted.allowed) return null;
    const response = sandboxRefusal(429, "Too many requests.");
    response.headers.set("Retry-After", String(admitted.retryAfterSeconds));
    return response;
  }

  private redirectToApp(page: PublicPage, path: string | undefined): Response {
    const app = this.deps.appOrigin?.();
    if (path !== undefined || !app) return sandboxRefusal(404, "Not found.");
    return sandboxRedirect(`${app}${publicArtifactPath(page.artifactId)}`);
  }

  private async servePublicFileOf(
    request: Request,
    host: ArtifactHost,
    ref: PublicRef | null,
    raw: string,
  ): Promise<Response> {
    if (!ref) return sandboxRefusal(404, "Not found.");
    const path = decodeSandboxFilePath(raw);
    const use = fileRequestUse(request.headers);
    if (path === null || !use) return sandboxRefusal(404, "Not found.");
    const refused = await this.admitPublic(request, use);
    if (refused) return refused;
    const loaded = await this.loadPublic(request, ref, path);
    if (loaded instanceof Response) return loaded;
    const page = loaded;
    if (page && !ref.guarded && page.access === "link") return this.redirectToApp(page, path);
    if (
      !page ||
      page.artifactId !== host.artifactId ||
      publicPageKind(page.kind) ||
      path !== page.entryPath
    )
      return sandboxRefusal(404, "Not found.");
    const drawn = publicFileDrawn(page.kind, page.sizeBytes);
    if (use === "subresource") {
      if (!drawn || page.kind !== "image" || request.headers.get("sec-fetch-dest") !== "image")
        return sandboxRefusal(404, "Not found.");
      const bytes = await this.deps.readBlob(page.workspaceId, page.sha256);
      return bytes
        ? sandboxAssetResponse(
            request.method,
            artifactContentType(path, "other"),
            bytes,
            "no-store",
          )
        : sandboxRefusal(404, "Not found.");
    }
    const shown = {
      method: request.method,
      title: page.title,
      acceptLanguage: request.headers.get("accept-language"),
      frameAncestor: this.frameAncestorOf(ref),
    };
    if (!drawn) return publicNoPreviewPage(shown);
    if (page.kind === "image") return publicImagePage({ ...shown, path });
    const bytes = await this.deps.readBlob(page.workspaceId, page.sha256);
    return bytes
      ? publicTextPage({ ...shown, kind: page.kind, bytes })
      : sandboxRefusal(404, "Not found.");
  }
}

export const useAllowed = (path: string, use: FileRequestUse) =>
  use === "subresource" || isPageFile(path);

const publicPageKind = (kind: ArtifactPathKind) => kind === "html" || kind === "markdown";

const publicUseAllowed = (path: string, use: FileRequestUse) =>
  useAllowed(path, use) || artifactKindOfPath(path) === "markdown";
