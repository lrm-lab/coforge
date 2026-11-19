import { expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import type { PublicPage } from "#src/server/artifacts/artifact-public-page.server";
import { encodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
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
  version: 3,
});

const sandbox = (lookup: () => Promise<PublicPage | null>, appOrigin: string | null = APP) =>
  new ArtifactSandbox({
    reads: {} as never,
    readBlob: async () => new TextEncoder().encode("<!doctype html><p>hi</p>"),
    origin: "https://sandbox.example",
    nonces: new MemoryTicketNonces(),
    secret: async () => "s".repeat(40),
    now: () => new Date("2026-11-19T08:00:00Z"),
    publicPage: lookup,
    appOrigin: () => appOrigin,
    publicClientAddress: () => "192.0.2.1",
  });

test("an old public link to a link-tier artifact redirects to the artifact's public page", async () => {
  const response = await sandbox(async () => page("link")).serve(
    new Request(`${ORIGIN}/p/${TOKEN}`),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${APP}/a/${encodeArtifactShortId(A)}`);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("a link-tier artifact's old content and file addresses no longer serve", async () => {
  const service = sandbox(async () => page("link"));
  for (const path of ["/page/index.html", "/file/index.html"])
    expect(
      (await service.serve(new Request(`${ORIGIN}/p/${TOKEN}${path}`, { headers: FRAME }))).status,
    ).toBe(404);
});

test("a revoked or unknown token is the same 404 as before", async () => {
  expect((await sandbox(async () => null).serve(new Request(`${ORIGIN}/p/${TOKEN}`))).status).toBe(
    404,
  );
});

test("a token on an artifact not yet moved to the link tier serves as it always did", async () => {
  const response = await sandbox(async () => page("conversation")).serve(
    new Request(`${ORIGIN}/p/${TOKEN}`),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`/p/${TOKEN}/page/index.html`);
});

test("with no application origin configured the redirect is a 404, never a guess", async () => {
  expect(
    (await sandbox(async () => page("link"), null).serve(new Request(`${ORIGIN}/p/${TOKEN}`)))
      .status,
  ).toBe(404);
});
