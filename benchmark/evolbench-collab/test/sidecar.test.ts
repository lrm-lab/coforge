import { expect, test } from "bun:test";
import { verifyWithSidecar } from "../src/sidecar";

test("the sidecar receives the final answer text for scorers that grade text", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json({ reward: 1, graded: true, feedback: "ok" });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const withAnswer = await verifyWithSidecar({
      sidecarUrl: url,
      registerWorkspaceDir: undefined,
      episodeId: "70",
      arm: "cold",
      finalOutput: "Exact Answer: X\nConfidence: 90%",
    });
    expect(withAnswer.verification).toMatchObject({ reward: 1, graded: true });
    expect(bodies[0]).toEqual({
      episode_id: "70",
      final_output: "Exact Answer: X\nConfidence: 90%",
    });
    await verifyWithSidecar({
      sidecarUrl: url,
      registerWorkspaceDir: undefined,
      episodeId: "71",
      arm: "cold",
      finalOutput: null,
    });
    expect(bodies[1]).toEqual({ episode_id: "71" });
  } finally {
    server.stop(true);
  }
});
