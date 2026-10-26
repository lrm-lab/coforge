/**
 * A real `Bun.serve` fake standing in for both the local daemon proxy (capabilities, session
 * create/complete/cancel) and the presigned PUT target, so the CLI's direct-upload flow runs a
 * genuine streamed HTTP PUT (`duplex: "half"`) rather than a mocked `fetch`. `putBehavior` is
 * mutated by each test to script the PUT endpoint's response(s) across attempts.
 */
export function directUploadServer(input: {
  putBehavior: () => number | "ok";
  onCancel?: () => void;
  completeBehavior?: () => { status: number; body: unknown };
}) {
  const completions: string[] = [];
  const puts: Array<{ headers: Headers; body: string }> = [];
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return Response.json({
          maxBytes: 1024,
          directUploadEnabled: true,
          directUploadThresholdBytes: 1,
          sessionExpiresInSeconds: 900,
        });
      }
      if (
        url.pathname === "/api/agent/v1/attachment-upload-sessions" &&
        request.method === "POST"
      ) {
        return Response.json(
          {
            uploadId: "upload-1",
            attachmentId: "attachment-1",
            state: "pending",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            upload: {
              method: "PUT",
              url: `http://127.0.0.1:${port}/presigned/attachment-1`,
              headers: { "Content-Type": "text/plain", "x-oss-forbid-overwrite": "true" },
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/agent/v1/attachment-upload-sessions/upload-1/complete") {
        completions.push("complete");
        const behavior = input.completeBehavior?.() ?? {
          status: 200,
          body: {
            uploadId: "upload-1",
            state: "completed",
            attachment: {
              id: "attachment-1",
              fileName: "note.txt",
              contentType: "text/plain",
              sizeBytes: 5,
            },
          },
        };
        return Response.json(behavior.body, { status: behavior.status });
      }
      if (
        url.pathname === "/api/agent/v1/attachment-upload-sessions/upload-1" &&
        request.method === "DELETE"
      ) {
        input.onCancel?.();
        return Response.json({ uploadId: "upload-1", state: "canceled" });
      }
      if (url.pathname === "/presigned/attachment-1" && request.method === "PUT") {
        puts.push({ headers: request.headers, body: await request.text() });
        const outcome = input.putBehavior();
        return outcome === "ok" ? new Response(null) : new Response(null, { status: outcome });
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return { server, completions, puts };
}
