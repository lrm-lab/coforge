import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import type { ArtifactReads } from "./artifact-reads.server";
import { pageLevelOf } from "./artifact-page-access.server";
import { pageAssetName, type ArtifactPageAssets } from "./artifact-page-assets.server";
import type { PageLevel } from "#src/features/artifacts/artifact-page-levels";
import { PAGE_RUNTIME_PATH } from "./artifact-page-runtime.server";
import { ArtifactPublicServing, useAllowed } from "./artifact-sandbox-public.server";
import type { PublicArtifactMissGuard } from "./artifact-public-miss-guard.server";
import type { LinkLookup, PublicPage } from "./artifact-public-page.server";
import { artifactPageOrigin, sandboxTarget } from "./artifact-sandbox-config.server";
import {
  ARTIFACT_HTML_LIMIT,
  fileRequestUse,
  isPageFile,
  isPdfDocument,
  isPdfFile,
  pageFileResponse,
  SIGNED_FILE_CACHE,
  type FileRequestUse,
} from "./artifact-sandbox-files.server";
import type { TicketNonces } from "./artifact-sandbox-nonces.server";
import { decodeSandboxFilePath, sandboxFileUrlPath } from "./artifact-sandbox-path.server";
import {
  sandboxAssetResponse,
  sandboxBlockedPage,
  sandboxRedirect,
  sandboxRefusal,
  sandboxRuntimeResponse,
} from "./artifact-sandbox-response.server";
import {
  readSandboxFileToken,
  readSandboxTicket,
  sandboxGrantExpired,
  signSandboxFileToken,
  signSandboxTicket,
} from "./artifact-sandbox-ticket.server";

export const SANDBOX_OPEN_PATH = "/_coforge/open";

export type SandboxDependencies = {
  reads: Pick<ArtifactReads, "read" | "file" | "fileInVersion">;
  readBlob(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
  pageAssets?: Pick<ArtifactPageAssets, "lookupByFileToken">;
  origin: string | null;
  nonces: TicketNonces;
  secret(): Promise<string>;
  now(): Date;
  publicPage?(token: string, path?: string): Promise<PublicPage | null>;
  linkPage?(artifactId: string, path?: string): Promise<LinkLookup>;
  missGuard?: PublicArtifactMissGuard;
  linkArtifactLimit?: AppRateLimit;
  appOrigin?: () => string | null;
  viewerName?: (workspaceId: string, userId: string) => Promise<string>;
  publicRateLimit?: AppRateLimit;
  publicFileRateLimit?: AppRateLimit;
  publicClientAddress?: (request: Request) => string | undefined;
};

export type ArtifactHost = { origin: string; artifactId: string; pageOrigin: string };

export class ArtifactSandbox {
  readonly #public: ArtifactPublicServing;

  constructor(private readonly deps: SandboxDependencies) {
    this.#public = new ArtifactPublicServing(deps);
  }

  async link(input: {
    workspaceId: string;
    userId: string;
    artifactId: string;
    version?: number;
    path?: string;
    embedderOrigin: string;
  }): Promise<{
    url: string;
    version: number;
    expiresAt: Date;
    viewer: { displayName: string; kind: "person" };
    level: PageLevel;
  }> {
    const origin = this.deps.origin;
    if (!origin)
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: "artifact-sandbox-off",
        hint: "this deployment has no sandbox origin for web pages (COFORGE_ARTIFACT_SANDBOX_ORIGIN)",
      });
    const sandboxHost = new URL(origin).hostname;
    const embedderHost = new URL(input.embedderOrigin).hostname;
    if (embedderHost === sandboxHost || embedderHost.endsWith(`.${sandboxHost}`))
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-sandbox-off" });
    const page = await this.page({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      userId: input.userId,
      version: input.version,
      path: input.path,
    });
    if (!page) throw new AppError("NOT_FOUND");
    const pageOrigin = artifactPageOrigin(origin, input.artifactId);
    const { ticket, expiresAt } = signSandboxTicket(
      {
        w: input.workspaceId,
        a: input.artifactId,
        v: page.version,
        u: input.userId,
        o: new URL(input.embedderOrigin).origin,
        s: pageOrigin,
        p: input.path,
      },
      await this.deps.secret(),
      this.deps.now(),
    );
    return {
      url: `${pageOrigin}${SANDBOX_OPEN_PATH}?ticket=${ticket}`,
      version: page.version,
      expiresAt,
      viewer: {
        displayName: (await this.deps.viewerName?.(input.workspaceId, input.userId)) ?? "",
        kind: "person",
      },
      level: page.level,
    };
  }

  async serve(request: Request): Promise<Response> {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") return sandboxRefusal(405, "Method not allowed.");
    const origin = this.deps.origin;
    if (!origin) return sandboxRefusal(404, "Not found.");
    const target = sandboxTarget(request, origin);
    if (target.kind !== "artifact") return sandboxRefusal(404, "Not found.");
    const host: ArtifactHost = {
      origin,
      artifactId: target.artifactId,
      pageOrigin: artifactPageOrigin(origin, target.artifactId),
    };
    const pathname = new URL(request.url).pathname;
    if (pathname === PAGE_RUNTIME_PATH) return sandboxRuntimeResponse(method);
    if (pathname === SANDBOX_OPEN_PATH) return this.open(request, host);
    const linkFile = /^\/l\/file\/(.+)$/.exec(pathname);
    if (linkFile) return this.#public.serveLinkFile(request, host, linkFile[1]!);
    const linkPage = /^\/l(?:\/page\/(.+))?$/.exec(pathname);
    if (linkPage) return this.#public.serveLink(request, host, linkPage[1]);
    const file = /^\/_f\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/.exec(pathname);
    if (file) return this.serveFile(request, host, file[1]!, file[2]!);
    const asset = /^\/_a\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/([^/]+)$/.exec(pathname);
    if (asset) return this.serveAsset(request, host, asset[1]!, asset[2]!);
    const publicFile = /^\/p\/([A-Za-z0-9_-]{43})\/file\/(.+)$/.exec(pathname);
    if (publicFile)
      return this.#public.servePublicFile(request, host, publicFile[1]!, publicFile[2]!);
    const publicPage = /^\/p\/([A-Za-z0-9_-]{43})(?:\/page\/(.+))?$/.exec(pathname);
    if (publicPage) return this.#public.servePublic(request, host, publicPage[1]!, publicPage[2]);
    return sandboxRefusal(404, "Not found.");
  }

  private async open(request: Request, host: ArtifactHost): Promise<Response> {
    if (request.method !== "GET") return sandboxRefusal(405, "Method not allowed.");
    const secret = await this.deps.secret();
    const ticket = readSandboxTicket(new URL(request.url).searchParams.get("ticket") ?? "", secret);
    if (
      !ticket ||
      ticket.s !== host.pageOrigin ||
      ticket.a !== host.artifactId ||
      !isOrigin(ticket.o)
    )
      return sandboxRefusal(404, "Not found.");
    const now = this.deps.now();
    if (sandboxGrantExpired(ticket, now))
      return sandboxBlockedPage({
        method: request.method,
        block: { reason: "expired", status: 403 },
        hostOrigin: ticket.o,
      });
    const remaining = ticket.exp - Math.floor(now.getTime() / 1000);
    if (!(await this.deps.nonces.claim(ticket.n, remaining)))
      return sandboxBlockedPage({
        method: request.method,
        block: { reason: "used", status: 401 },
        hostOrigin: ticket.o,
      });
    const page = await this.page({
      workspaceId: ticket.w,
      artifactId: ticket.a,
      userId: ticket.u,
      version: ticket.v,
      path: ticket.p,
    }).catch(refusable);
    if (!page) return sandboxRefusal(404, "Not found.");
    const token = signSandboxFileToken(
      { w: ticket.w, a: ticket.a, v: ticket.v, u: ticket.u, o: ticket.o, s: ticket.s },
      secret,
      now,
    );
    return sandboxRedirect(`/_f/${token}/${sandboxFileUrlPath(page.openPath)}`);
  }

  private async serveFile(
    request: Request,
    host: ArtifactHost,
    tokenValue: string,
    raw: string,
  ): Promise<Response> {
    const path = decodeSandboxFilePath(raw);
    const use = fileRequestUse(request.headers);
    if (!path || !use || !signedUseAllowed(path, use)) return sandboxRefusal(404, "Not found.");
    const token = readSandboxFileToken(tokenValue, await this.deps.secret());
    if (!token || token.s !== host.pageOrigin || token.a !== host.artifactId || !isOrigin(token.o))
      return sandboxRefusal(404, "Not found.");
    if (sandboxGrantExpired(token, this.deps.now()))
      return use === "frame"
        ? sandboxBlockedPage({
            method: request.method,
            block: { reason: "expired", status: 403 },
            hostOrigin: token.o,
          })
        : sandboxRefusal(403, "This link has expired. Open the page again from CoForge.");
    const row =
      isPageFile(path) || isPdfDocument(path, use)
        ? await this.deps.reads
            .file({
              workspaceId: token.w,
              artifactId: token.a,
              reader: { userId: token.u },
              version: token.v,
              path,
            })
            .catch(refusable)
        : await this.deps.reads.fileInVersion({
            workspaceId: token.w,
            artifactId: token.a,
            version: token.v,
            path,
          });
    if (!row || (isPageFile(path) && row.sizeBytes > ARTIFACT_HTML_LIMIT))
      return sandboxRefusal(404, "Not found.");
    return (
      pageFileResponse({
        method: request.method,
        path,
        bytes: await this.deps.readBlob(token.w, row.sha256),
        use,
        pageOrigin: host.pageOrigin,
        frameAncestor: token.o,
        hostOrigin: token.o,
        filePrefix: `${host.pageOrigin}/_f/${tokenValue}/`,
        assetPrefix: this.deps.pageAssets ? `${host.pageOrigin}/_a/${tokenValue}/` : undefined,
        fileCache: SIGNED_FILE_CACHE,
      }) ?? sandboxRefusal(404, "Not found.")
    );
  }

  private async serveAsset(
    request: Request,
    host: ArtifactHost,
    tokenValue: string,
    raw: string,
  ): Promise<Response> {
    const name = decodedAssetName(raw);
    if (!name || !this.deps.pageAssets || fileRequestUse(request.headers) !== "subresource")
      return sandboxRefusal(404, "Not found.");
    const token = readSandboxFileToken(tokenValue, await this.deps.secret());
    if (!token || token.s !== host.pageOrigin || token.a !== host.artifactId || !isOrigin(token.o))
      return sandboxRefusal(404, "Not found.");
    if (sandboxGrantExpired(token, this.deps.now()))
      return sandboxRefusal(403, "This link has expired. Open the page again from CoForge.");
    const asset = await this.deps.pageAssets.lookupByFileToken(token.a, name);
    const bytes = asset ? await this.deps.readBlob(token.w, asset.sha256) : null;
    if (!asset || !bytes) return sandboxRefusal(404, "Not found.");
    return sandboxAssetResponse(request.method, asset.contentType, bytes);
  }

  private async page(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    version?: number;
    path?: string;
  }): Promise<{ version: number; openPath: string; level: PageLevel } | null> {
    const { version, files, artifact, authorAgentOwnerId } = await this.deps.reads.read({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      reader: { userId: input.userId },
      version: input.version,
    });
    if (!version) return null;
    const openPath = input.path ?? version.entryPath;
    const openable = isPageFile(openPath) || (input.path !== undefined && isPdfFile(openPath));
    if (!openable) return null;
    const opened = files.find((file) => file.path === openPath);
    if (!opened || (isPageFile(openPath) && opened.sizeBytes > ARTIFACT_HTML_LIMIT)) return null;
    return {
      version: version.number,
      openPath,
      level: pageLevelOf({ canChange: artifact.canChange, authorAgentOwnerId }, input.userId),
    };
  }
}

const signedUseAllowed = (path: string, use: FileRequestUse) =>
  useAllowed(path, use) || isPdfFile(path);

function refusable(error: unknown): null {
  if (!(error instanceof AppError)) throw error;
  return null;
}

function decodedAssetName(raw: string): string | null {
  try {
    return pageAssetName(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
