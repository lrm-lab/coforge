import { join } from "node:path";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { siteBytes, siteRow, type Site } from "./artifact-sandbox-site";
import { chromePath, launchHeadlessChrome } from "./headless-chrome";

export const COLLECT = `window.__messages = []; addEventListener("message", (e) => window.__messages.push(e.data));`;

export type Seen = { file: string; dest: string | null; site: string | null; mode: string | null };

type SiteContext = { out: string; tcp: string; stunPort: number; id: Record<string, string> };

export type SandboxBrowserEnv = Awaited<ReturnType<typeof startSandboxBrowserEnv>>;

export async function startSandboxBrowserEnv(
  names: readonly string[],
  sitesOf: (context: SiteContext) => Promise<Record<string, Site>> | Record<string, Site>,
) {
  const chrome = chromePath();
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const hits: string[] = [];
  const outside = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
      if (url.pathname === "/embed") return framing(url.searchParams.get("src")!);
      hits.push(url.pathname);
      return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
    },
  });
  const tcpState = { connections: 0 };
  const tcp = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => {
        tcpState.connections += 1;
        socket.end();
      },
      data: () => {},
    },
  });
  const stun = await Bun.udpSocket({
    hostname: "127.0.0.1",
    socket: { data: () => void hits.push("/stun") },
  });
  const ID = Object.fromEntries(names.map((name) => [name, crypto.randomUUID()])) as Record<
    string,
    string
  >;
  const sites = await sitesOf({
    out: `http://127.0.0.1:${outside.port}`,
    tcp: `http://127.0.0.1:${tcp.port}`,
    stunPort: stun.port,
    id: ID,
  });
  const SITES: Record<string, Site> = sites;
  const seen: Seen[] = [];
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "artifact-page-host-entry.ts")],
    target: "browser",
  });
  if (!built.success) throw new Error("the host page's script did not build");
  const hostScript = await built.outputs[0]!.text();
  let sandbox: ArtifactSandbox;
  const sandboxServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const match = /^\/_f\/[^/]+\/(.+)$/.exec(new URL(request.url).pathname);
      const header = (name: string) => request.headers.get(name);
      if (match)
        seen.push({
          file: decodeURIComponent(match[1]!),
          dest: header("sec-fetch-dest"),
          site: header("sec-fetch-site"),
          mode: header("sec-fetch-mode"),
        });
      return sandbox.serve(request);
    },
  });
  sandbox = new ArtifactSandbox({
    reads: {
      read: async (input: { artifactId: string }) => {
        const site = SITES[input.artifactId]!;
        return {
          artifact: {},
          version: { number: 1, entryPath: site.entry },
          files: Object.keys(site.files).map((path) => siteRow(SITES, input.artifactId, path)),
        } as never;
      },
      file: async (input: { artifactId: string; path: string }) =>
        siteRow(SITES, input.artifactId, input.path),
      fileInVersion: async (input: { artifactId: string; path: string }) =>
        siteRow(SITES, input.artifactId, input.path),
    },
    readBlob: async (_workspaceId, sha256) => siteBytes(SITES, sha256),
    origin: `http://localhost:${sandboxServer.port}`,
    nonces: new MemoryTicketNonces(),
    secret: async () => "x".repeat(40),
    now: () => new Date(),
  });
  const app = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
      return hostPage(url.searchParams, hostScript);
    },
  });
  const browser = await launchHeadlessChrome(chrome);
  const appOrigin = `http://127.0.0.1:${app.port}`;
  return {
    hits,
    seen,
    ID,
    SITES,
    sandbox,
    sandboxPort: sandboxServer.port,
    browser,
    tcpState,
    out: `http://127.0.0.1:${outside.port}`,
    stunPort: stun.port,
    linkFor: async (name: string, embedderOrigin = appOrigin) =>
      (
        await sandbox.link({
          workspaceId: "w",
          userId: "u",
          artifactId: ID[name] ?? name,
          embedderOrigin,
        })
      ).url,
    inApp: (link: string, name = "probe") =>
      `${appOrigin}/?${new URLSearchParams({
        src: link,
        origin: new URL(link).origin,
        artifact: ID[name] ?? name,
      })}`,
    async stop() {
      await browser.close();
      for (const server of [outside, sandboxServer, app]) server.stop(true);
      tcp.stop(true);
      stun.close();
    },
  };
}

function framing(src: string): Response {
  return new Response(
    `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts allow-same-origin" src="${src}"></iframe></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function hostPage(params: URLSearchParams, hostScript: string): Response {
  const src = params.get("src") ?? "";
  return new Response(
    `<!doctype html><html><body style="margin:0"><iframe id="f" style="border:0;width:100%;height:600px" sandbox="allow-scripts allow-same-origin" allow="clipboard-read 'none'; clipboard-write 'none'" referrerpolicy="no-referrer" data-src="${src}"></iframe><script>${hostScript.replaceAll("</script", "<\\/script")}</script></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
