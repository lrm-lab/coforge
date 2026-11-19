import { expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import type { LinkLookup, PublicPage } from "#src/server/artifacts/artifact-public-page.server";
import { FRAME } from "./helpers/artifact-sandbox-open";

const A = "11111111-1111-4111-8111-111111111111";
const ORIGIN = `https://a-${A}.sandbox.example`;
const APP = "https://app.example";
const TOKEN = "t".repeat(43);

const page = (access: string): PublicPage => ({
  workspaceId: "w1",
  artifactId: A,
  title: "Page",
  kind: "html",
  entryPath: "index.html",
  sha256: "sha",
  sizeBytes: 10,
  access,
  workspaceSlug: "acme",
  version: 3,
});

const sandbox = (appOrigin: string | null, kind: PublicPage["kind"] = "html") =>
  new ArtifactSandbox({
    reads: {} as never,
    readBlob: async () => new TextEncoder().encode("<!doctype html><p>hi</p>"),
    origin: "https://sandbox.example",
    nonces: new MemoryTicketNonces(),
    secret: async () => "s".repeat(40),
    now: () => new Date("2026-11-19T08:00:00Z"),
    linkPage: async (): Promise<LinkLookup> => ({
      shared: true,
      page: { ...page("link"), kind },
    }),
    publicPage: async () => ({ ...page("public"), kind }),
    appOrigin: () => appOrigin,
    publicClientAddress: () => "192.0.2.1",
  });

const policy = async (service: ArtifactSandbox, path: string) =>
  (await service.serve(new Request(`${ORIGIN}${path}`, { headers: FRAME }))).headers.get(
    "content-security-policy",
  );

test("a link-tier page may be framed by the application's own origin and nobody else", async () => {
  const csp = await policy(sandbox(APP), "/l/page/index.html");
  expect(csp).toContain(`frame-ancestors ${APP}`);
  expect(csp).not.toContain("frame-ancestors 'none'");
});

test("a link-tier page stays unframeable when no application origin is configured", async () => {
  expect(await policy(sandbox(null), "/l/page/index.html")).toContain("frame-ancestors 'none'");
});

test("a public-token page is unframeable even when the application origin is configured", async () => {
  expect(await policy(sandbox(APP), `/p/${TOKEN}/page/index.html`)).toContain(
    "frame-ancestors 'none'",
  );
});

test("a link-tier markdown page may be framed by the application's own origin too", async () => {
  const csp = await policy(sandbox(APP, "markdown"), "/l/page/index.html");
  expect(csp).toContain(`frame-ancestors ${APP}`);
  expect(csp).not.toContain("frame-ancestors 'none'");
});

test("a public-token markdown page is unframeable even when the application origin is configured", async () => {
  expect(await policy(sandbox(APP, "markdown"), `/p/${TOKEN}/page/index.html`)).toContain(
    "frame-ancestors 'none'",
  );
});
