import { AppError } from "#src/lib/app-error";
import type { ArtifactReads } from "./artifact-reads.server";
import { ARTIFACT_DOCUMENT_LIMIT } from "./artifact-files.server";
import {
  sandboxPageHeaders,
  sandboxRefusal,
  sandboxWrapper,
  withWebRtcOff,
} from "./artifact-sandbox-response.server";
import { readSandboxTicket, signSandboxTicket } from "./artifact-sandbox-ticket.server";

/** A web page's one file in the first step (task #490): everything else is inlined into it. */
export const ARTIFACT_HTML_ENTRY = "index.html";
/** A web page at most, as a document (2 MiB). */
export const ARTIFACT_HTML_LIMIT = ARTIFACT_DOCUMENT_LIMIT;

type SandboxDependencies = {
  reads: Pick<ArtifactReads, "read">;
  /** One blob's bytes, or null when it is gone. */
  readBlob(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
  /** The sandbox origin, or null when web pages are off. */
  origin: string | null;
  secret(): Promise<string>;
  now(): Date;
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
    if (new URL(origin).host === new URL(input.embedderOrigin).host)
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
   * The sandbox origin's every answer. A valid link (`/a/<ticket>`) is the wrapper; the wrapper's
   * frame (`/a/<ticket>/page`) is the page, only as the wrapper's frame (`Sec-Fetch-Dest: iframe`,
   * `Sec-Fetch-Site: same-origin`), so it is never a document of its own, nor the app's frame; anything else is a refusal.
   */
  async serve(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return sandboxRefusal(405, "Method not allowed.");
    const match = /^\/a\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/page)?$/.exec(
      new URL(request.url).pathname,
    );
    if (!match || !this.deps.origin) return sandboxRefusal(404, "Not found.");
    const framed = match[2] === "/page";
    // The page only as our wrapper's frame: a frame (not a tab), asked for by a document of the
    // sandbox origin. Framed by the app directly it would be out from under the wrapper's
    // `frame-src`, free to navigate its frame anywhere. A browser that sends no `Sec-Fetch-*`
    // gets nothing.
    if (
      framed &&
      (request.headers.get("sec-fetch-dest") !== "iframe" ||
        request.headers.get("sec-fetch-site") !== "same-origin")
    )
      return sandboxRefusal(404, "Not found.");
    const ticket = readSandboxTicket(match[1]!, await this.deps.secret(), this.deps.now());
    if (ticket === "expired")
      return sandboxRefusal(403, "This link has expired. Open the page again from CoForge.");
    if (!ticket || !isOrigin(ticket.o)) return sandboxRefusal(404, "Not found.");
    let page: Awaited<ReturnType<ArtifactSandbox["page"]>>;
    try {
      page = await this.page({
        workspaceId: ticket.w,
        artifactId: ticket.a,
        userId: ticket.u,
        version: ticket.v,
      });
    } catch (error) {
      // Gone, or no longer readable by this reader: the same answer for both. Anything else (the
      // database down) is not a refusal and reaches the caller's 502.
      if (!(error instanceof AppError)) throw error;
      page = null;
    }
    if (!page) return sandboxRefusal(404, "Not found.");
    const origins = { sandboxOrigin: this.deps.origin, appOrigin: ticket.o };
    if (!framed) {
      const wrapper = sandboxWrapper({ pagePath: `/a/${match[1]}/page`, ...origins });
      return request.method === "HEAD" ? new Response(null, wrapper) : wrapper;
    }
    const bytes = await this.deps.readBlob(ticket.w, page.sha256);
    if (!bytes || bytes.byteLength > ARTIFACT_HTML_LIMIT) return sandboxRefusal(404, "Not found.");
    const served = withWebRtcOff(bytes);
    const headers = sandboxPageHeaders(origins);
    headers.set("Content-Length", String(served.byteLength));
    const body = request.method === "HEAD" ? null : new Blob([served]);
    return new Response(body, { status: 200, headers });
  }

  /** The web page the reader may read at `version` (the current one by default): its version
   * and its one file. Null when it is not a web page, has no version yet, or its file is not the
   * one `index.html` within the limit. Throws as `ArtifactReads.read` does where it cannot read. */
  private async page(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    version?: number;
  }): Promise<{ version: number; sha256: string } | null> {
    const { artifact, version, files } = await this.deps.reads.read({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      reader: { userId: input.userId },
      version: input.version,
    });
    if (artifact.kind !== "html" || !version || version.entryPath !== ARTIFACT_HTML_ENTRY)
      return null;
    const entry = files.find((file) => file.path === ARTIFACT_HTML_ENTRY);
    if (!entry || entry.sizeBytes > ARTIFACT_HTML_LIMIT) return null;
    return { version: version.number, sha256: entry.sha256 };
  }
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
