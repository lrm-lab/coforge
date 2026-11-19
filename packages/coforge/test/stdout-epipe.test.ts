import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { installStdoutEpipeGuard } from "#src/cli";

describe("installStdoutEpipeGuard", () => {
  test("calls onEpipe once on EPIPE errors and rethrows other errors", () => {
    const emitter = new EventEmitter();
    let epipeCalls = 0;
    const dispose = installStdoutEpipeGuard(emitter, () => {
      epipeCalls += 1;
    });
    try {
      const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      emitter.emit("error", epipe);
      emitter.emit("error", epipe);
      expect(epipeCalls).toBe(1);

      const other = Object.assign(new Error("io failure"), { code: "EIO" });
      expect(() => emitter.emit("error", other)).toThrow("io failure");
      expect(epipeCalls).toBe(1);
    } finally {
      dispose();
    }
  });

  test("producer process itself exits 0 with empty stderr when pipe reader closes early", async () => {
    const script =
      'import { installStdoutEpipeGuard } from "./src/cli"; installStdoutEpipeGuard(); for (let i = 0; i < 4000; i++) process.stdout.write("x".repeat(256) + "\\n");';
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
