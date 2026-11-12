import { AppError } from "#src/lib/app-error";
import {
  NO_RATE_LIMIT,
  type AppRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import { clientAddress } from "#src/server/http/public-origin.server";
import type { ArtifactReads } from "./artifact-reads.server";
import {
  ARTIFACT_HTML_LIMIT,
  fileRequestUse,
  isPageFile,
  pageFileResponse,
  type FileRequestUse,
} from "./artifact-sandbox-files.server";
import { decodeSandboxFilePath, sandboxFileUrlPath } from "./artifact-sandbox-path.server";
import { sandboxRefusal, sandboxWrapper } from "./artifact-sandbox-response.server";
import {
  readSandboxTicket,
  sandboxWrapperOpen,
  signSandboxTicket,
} from "./artifact-sandbox-ticket.server";
import { publicMarkdownPage } from "./artifact-public-markdown.server";

type SandboxDependencies = {
  reads: Pick<ArtifactReads, "read" | "file">;
  /** One blob's bytes, or null when it is gone. */
  readBlob(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
  /** The sandbox origin, or null when web pages are off. */
  origin: string | null;
  secret(): Promise<string>;
  now(): Date;
  /** What a public link shows now: its artifact's current version's entry path, and the sha256 of
   * the file at `path` (the entry's, when none is asked for). Null when there is none. */
  publicPage?(
    token: string,
    path?: string,
  ): Promise<{
    workspaceId: string;
    artifactId: string;
    title: string;
    kind: "html" | "markdown";
    entryPath: string;
    sha256: string;
  } | null>;
  publicRateLimit?: AppRateLimit;
  publicClientAddress?: (request: Request) => string | undefined;
};

/**
 * Web-page artifacts on their own origin (task #490). `link` is the application's half: it checks
 * the reader may read the page, then returns a short-lived signed link on the sandbox origin.
 * `serve` is the sandbox's half: it answers only such a link, checks the reader's access once
 * more (it may have changed since the link was made), and returns our wrapper framing the page,
 * the page with headers that let its own scripts run and nothing load or leave
 * (`artifact-sandbox-response.server.ts`).
 */
export class ArtifactSandbox {
  constructor(private readonly deps: SandboxDependencies) {}

  async link(input: {
    workspaceId: string;
    userId: string;
    artifactId: string;
    version?: number;
    /** The application origin the page is opened from, which alone may frame it. */
    embedderOrigin: string;
  }): Promise<{ url: string; version: number; expiresAt: Date }> {
    const origin = this.deps.origin;
    if (!origin)
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: "artifact-sandbox-off",
        hint: "this deployment has no sandbox origin for web pages (COFORGE_ARTIFACT_SANDBOX_ORIGIN)",
      });
    // A sandbox on the application's own host would be no sandbox: refuse rather than serve.
    if (new URL(origin).hostname === new URL(input.embedderOrigin).hostname)
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-sandbox-off" });
    const page = await this.page({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      userId: input.userId,
      version: input.version,
    });
    if (!page) throw new AppError("NOT_FOUND");
    const { ticket, expiresAt } = signSandboxTicket(
      {
        w: input.workspaceId,
        a: input.artifactId,
        v: page.version,
        u: input.userId,
        o: new URL(input.embedderOrigin).origin,
      },
      await this.deps.secret(),
      this.deps.now(),
    );
    return { url: `${origin}/a/${ticket}`, version: page.version, expiresAt };
  }

  /**
   * The sandbox origin's every answer. A valid link (`/a/<ticket>`) is the wrapper; every file of
   * the link's version is under it (`/a/<ticket>/page/<path>`): a page file only as a frame (the
   * wrapper's, or a link followed inside it), any other file only as a subresource of a page
   * (`fileRequestUse`), so none is ever a document of its own, nor the app's frame; anything else
   * is a refusal. The wrapper opens for five minutes after the link was made, its files for thirty.
   */
  async serve(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return sandboxRefusal(405, "Method not allowed.");
    const pathname = new URL(request.url).pathname;
    const publicMatch = /^\/p\/([A-Za-z0-9_-]{43})(?:\/page\/(.+))?$/.exec(pathname);
    if (publicMatch) return this.servePublic(request, publicMatch[1]!, publicMatch[2]);
    const match = /^\/a\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:\/page\/(.+))?$/.exec(pathname);
    if (!match || !this.deps.origin) return sandboxRefusal(404, "Not found.");
    const file = match[2] === undefined ? undefined : requestedFile(request, match[2]);
    if (file === null) return sandboxRefusal(404, "Not found.");
    const ticket = readSandboxTicket(match[1]!, await this.deps.secret(), this.deps.now());
    if (
      ticket === "expired" ||
      (ticket && file === undefined && !sandboxWrapperOpen(ticket, this.deps.now()))
    )
      return sandboxRefusal(403, "This link has expired. Open the page again from CoForge.");
    if (!ticket || !isOrigin(ticket.o)) return sandboxRefusal(404, "Not found.");
    const reader = { userId: ticket.u };
    const origins = { sandboxOrigin: this.deps.origin, appOrigin: ticket.o };
    // Gone, or no longer readable by this reader: the same answer for both. Anything else (the
    // database down) is not a refusal and reaches the caller's 502.
    const refusable = (error: unknown) => {
      if (!(error instanceof AppError)) throw error;
      return null;
    };
    if (file === undefined) {
      const page = await this.page({
        workspaceId: ticket.w,
        artifactId: ticket.a,
        userId: ticket.u,
        version: ticket.v,
      }).catch(refusable);
      if (!page) return sandboxRefusal(404, "Not found.");
      const wrapper = sandboxWrapper({
        pagePath: `/a/${match[1]}/page/${sandboxFileUrlPath(page.entryPath)}`,
        ...origins,
      });
      return request.method === "HEAD" ? new Response(null, wrapper) : wrapper;
    }
    const row = await this.deps.reads
      .file({
        workspaceId: ticket.w,
        artifactId: ticket.a,
        reader,
        version: ticket.v,
        path: file,
      })
      .catch(refusable);
    if (!row || (isPageFile(file) && row.sizeBytes > ARTIFACT_HTML_LIMIT))
      return sandboxRefusal(404, "Not found.");
    return (
      pageFileResponse({
        method: request.method,
        path: file,
        bytes: await this.deps.readBlob(ticket.w, row.sha256),
        origins,
        filePrefix: `${this.deps.origin}/a/${match[1]}/page/`,
      }) ?? sandboxRefusal(404, "Not found.")
    );
  }

  private async servePublic(request: Request, token: string, raw?: string): Promise<Response> {
    if (!this.deps.publicPage) return sandboxRefusal(404, "Not found.");
    const rateLimit = await (this.deps.publicRateLimit ?? NO_RATE_LIMIT).admit(
      (this.deps.publicClientAddress ?? clientAddress)(request) ?? "unknown",
    );
    if (!rateLimit.allowed) {
      const response = sandboxRefusal(429, "Too many requests.");
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const origin = this.deps.origin!;
    const origins = { sandboxOrigin: origin, appOrigin: "'none'" };
    // A public link is the wrapper (no path) or one file of its artifact's current version, which
    // is a frame or a subresource by the same rules as a signed link's; a Markdown page has only
    // its entry, always a frame.
    const path = raw === undefined ? undefined : decodeSandboxFilePath(raw);
    const use = path === undefined ? null : fileRequestUse(request.headers);
    if (path === null || (path !== undefined && (!use || (use !== "frame" && isPageFile(path)))))
      return sandboxRefusal(404, "Not found.");
    const page = await this.deps.publicPage(token, path);
    if (!page) return sandboxRefusal(404, "Not found.");
    if (path === undefined) {
      const wrapper = sandboxWrapper({
        pagePath: `/p/${token}/page/${sandboxFileUrlPath(page.entryPath)}`,
        ...origins,
      });
      return request.method === "HEAD" ? new Response(null, wrapper) : wrapper;
    }
    const framed: FileRequestUse =
      page.kind === "markdown" || isPageFile(path) ? "frame" : "subresource";
    if (use !== framed || (page.kind === "markdown" && path !== page.entryPath))
      return sandboxRefusal(404, "Not found.");
    const bytes = await this.deps.readBlob(page.workspaceId, page.sha256);
    if (page.kind === "markdown") {
      if (!bytes || bytes.byteLength > ARTIFACT_HTML_LIMIT)
        return sandboxRefusal(404, "Not found.");
      const served = publicMarkdownPage(page.title, new TextDecoder().decode(bytes));
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        // Framed by its wrapper, on this origin; 'none' here leaves a broken frame.
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${origin}`,
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      headers.set("Content-Length", String(served.byteLength));
      return new Response(request.method === "HEAD" ? null : new Blob([served]), {
        status: 200,
        headers,
      });
    }
    return (
      pageFileResponse({
        method: request.method,
        path,
        bytes,
        origins,
        filePrefix: `${origin}/p/${token}/page/`,
      }) ?? sandboxRefusal(404, "Not found.")
    );
  }

  /** The web page the reader may read at `version` (the current one by default): its version and
   * its entry file's path. Null when it is not a web page, has no version yet, or its entry is
   * not an html file within the limit. Throws as `ArtifactReads.read` does where it cannot read. */
  private async page(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    version?: number;
  }): Promise<{ version: number; entryPath: string } | null> {
    const { artifact, version, files } = await this.deps.reads.read({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      reader: { userId: input.userId },
      version: input.version,
    });
    if (artifact.kind !== "html" || !version || !isPageFile(version.entryPath)) return null;
    const entry = files.find((file) => file.path === version.entryPath);
    if (!entry || entry.sizeBytes > ARTIFACT_HTML_LIMIT) return null;
    return { version: version.number, entryPath: version.entryPath };
  }
}

/** The artifact path a link's file URL asks for, when the browser says it is a frame or a
 * subresource of the right kind for it; null when it names no file or is not asked that way. */
function requestedFile(request: Request, raw: string): string | null {
  const path = decodeSandboxFilePath(raw);
  if (!path) return null;
  const use = fileRequestUse(request.headers);
  return use === (isPageFile(path) ? "frame" : "subresource") ? path : null;
}

/** An http(s) origin and nothing else, so it goes into `frame-ancestors` as it is. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
