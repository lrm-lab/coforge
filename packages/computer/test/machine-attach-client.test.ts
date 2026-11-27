import { expect, test } from "bun:test";
import { computerAttachWire } from "@lrm/coforge-sdk/internal/computer-attach-session";
import { MachineAttachClient } from "#src/setup/machine-attach-client";

test("falls back only when the server explicitly lacks attach sessions", async () => {
  const absent = new MachineAttachClient(
    "https://example.test",
    async () => new Response(null, { status: 404 }),
  );
  expect(await absent.supported()).toBe(false);
  const serverError = new MachineAttachClient(
    "https://example.test",
    async () => new Response(null, { status: 503 }),
  );
  await expect(serverError.supported()).rejects.toMatchObject({
    code: "ATTACH_SERVER_UNAVAILABLE",
  });
  const valid = new MachineAttachClient(
    "https://example.test",
    async () =>
      new Response(Uint8Array.from(computerAttachWire.capabilities.encode({ protocolMajor: 1 })), {
        headers: { "content-type": "application/protobuf" },
      }),
  );
  expect(await valid.supported()).toBe(true);
  const captivePortal = new MachineAttachClient(
    "https://example.test",
    async () => new Response("<html></html>"),
  );
  await expect(captivePortal.supported()).rejects.toMatchObject({
    code: "ATTACH_PROTOCOL_INVALID",
  });
});

test("sends preflight proof exclusively as its dedicated Bearer credential", async () => {
  const sessionId = crypto.randomUUID();
  const key = "local-test-only";
  const client = new MachineAttachClient("https://example.test", async (url, init) => {
    expect(url).toBe(`https://example.test/api/computer/attach/sessions/${sessionId}/preflight`);
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
    return new Response(
      Uint8Array.from(
        computerAttachWire.preflightResponse.encode({
          computerId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          workspaceSlug: "team",
        }),
      ),
      { headers: { "content-type": "application/protobuf" } },
    );
  });
  expect(await client.preflight(sessionId, key)).toMatchObject({ workspaceSlug: "team" });
});
