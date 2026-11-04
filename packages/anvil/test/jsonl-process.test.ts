import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { type OwnedProcessTree } from "@lrm/coforge-anvil";
import { captureDaemonLogs } from "./fixtures/log-capture";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

test("a response written just before the process exits is delivered, not failed as an exit", async () => {
  const output = Promise.withResolvers<void>();
  const tree = {
    child: {
      pid: 1,
      exited: Promise.resolve(0),
      exitCode: 0,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: {
        async *[Symbol.asyncIterator]() {
          await output.promise;
          yield new TextEncoder().encode('{"id":"coforge-1","result":"late"}\n');
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  try {
    const response = process.request({ method: "ping" });
    // The exit has been observed long before the final output is readable.
    setTimeout(output.resolve, 20);
    expect(await response).toMatchObject({ result: "late" });
  } finally {
    await process.dispose();
  }
});

test("close waits for bounded split stderr diagnostics after process exit", async () => {
  const stderr = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const lines: string[] = [];
  const tree = {
    child: {
      pid: 1,
      exited: Promise.resolve(1),
      exitCode: 1,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: {
        async *[Symbol.asyncIterator]() {
          await stderr.promise;
          const encoder = new TextEncoder();
          yield encoder.encode("No conversation found with session ID: ");
          yield encoder.encode("selected\r\n");
          yield encoder.encode("x".repeat(5000) + "\nlast diagnostic");
        },
      },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  let didClose = false;
  process.onStderr((line) => lines.push(line));
  process.onFailure(() => failed.resolve());
  process.onClose(() => {
    didClose = true;
    closed.resolve();
  });
  try {
    await failed.promise;
    expect(didClose).toBe(false);
    stderr.resolve();
    await closed.promise;
    expect(lines).toEqual([
      "No conversation found with session ID: selected",
      "[oversized stderr diagnostic]",
      "last diagnostic",
    ]);
  } finally {
    stderr.resolve();
    await process.dispose();
  }
});

test("send waits for stdin drain after a backpressured write", async () => {
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => (releaseDrain = resolve));
  const never = new Promise<number>(() => undefined);
  const tree = {
    child: {
      pid: 1,
      exited: never,
      exitCode: null,
      stdin: { write: () => false, end: () => undefined, flush: () => drain },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(
    ["unused"],
    tmpdir(),
    {},
    {
      spawn: () => tree,
    },
  );

  let completed = false;
  const sending = process.send({ method: "backpressure" }).then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);
  releaseDrain();
  await sending;
  expect(completed).toBe(true);
});

test("invalid child output permanently fails current and future requests", async () => {
  const child = new JsonlProcess(
    [globalThis.process.execPath, new URL("./fixtures/invalid-jsonl.ts", import.meta.url).pathname],
    tmpdir(),
    { PATH: globalThis.process.env.PATH ?? "" },
    fixturePerTurnHost.processTreeSpawner,
  );

  try {
    await Bun.sleep(20);
    await expect(child.request({ method: "after-invalid-output" })).rejects.toThrow(
      "invalid output",
    );
    await expect(child.request({ method: "still-failed" })).rejects.toThrow("invalid output");
  } finally {
    await child.dispose();
  }
});

test("dispose allows five seconds for graceful exit before force terminating the tree", async () => {
  const exited = Promise.withResolvers<number>();
  const signals: boolean[] = [];
  const waits: number[] = [];
  let force = false;
  const tree = {
    child: {
      pid: 1,
      exited: exited.promise,
      exitCode: null,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: {
        async *[Symbol.asyncIterator]() {
          await exited.promise;
          yield* [];
        },
      },
      stderr: {
        async *[Symbol.asyncIterator]() {
          await exited.promise;
          yield* [];
        },
      },
      kill: () => undefined,
    },
    async terminate(forced: boolean) {
      signals.push(forced);
      force = forced;
      if (forced) exited.resolve(137);
    },
    async waitForExit(timeoutMs: number) {
      waits.push(timeoutMs);
      return force;
    },
  } satisfies OwnedProcessTree;
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  await process.dispose();
  expect(signals).toEqual([false, true]);
  expect(waits[0]).toBe(5_000);
});

/** The stderr lines a process reports for `chunks`, once it has exited and drained. */
async function stderrLines(chunks: readonly (string | Uint8Array)[]): Promise<string[]> {
  const encoder = new TextEncoder();
  const closed = Promise.withResolvers<void>();
  const tree = {
    child: {
      pid: 1,
      exited: Promise.resolve(0),
      exitCode: 0,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderr: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks)
            yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        },
      },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
  const lines: string[] = [];
  const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
  process.onStderr((line) => lines.push(line));
  process.onClose(() => closed.resolve());
  await closed.promise;
  return lines;
}

test("stderr lines arrive in order across chunk boundaries, without one trailing carriage return", async () => {
  expect(await stderrLines(["first\r\nsec", "ond\nthi", "rd\r", "\n\nlast"])).toEqual([
    "first",
    "second",
    "third",
    "",
    "last",
  ]);
});

test("a stderr line whose UTF-8 is split across chunks is reported whole", async () => {
  const bytes = new TextEncoder().encode("诊断😀信息\n");
  expect(
    await stderrLines([bytes.subarray(0, 4), bytes.subarray(4, 9), bytes.subarray(9)]),
  ).toEqual(["诊断😀信息"]);
});

test("a stderr line is oversized only past 4096 characters, carriage return included", async () => {
  const bound = "x".repeat(4096);
  expect(
    await stderrLines([
      `${bound}\n`,
      `${bound}y\nshort\n`,
      `${bound}\r\n`,
      `${"x".repeat(2000)}`,
      `${"x".repeat(3000)}\nafter\n`,
    ]),
  ).toEqual([
    bound,
    "[oversized stderr diagnostic]",
    "short",
    "[oversized stderr diagnostic]",
    "[oversized stderr diagnostic]",
    "after",
  ]);
});

test("a character that starts below the stderr bound is kept whole even when it ends past it", async () => {
  const line = `${"x".repeat(4095)}😀`;
  expect(await stderrLines([`${line}\n`, `${line}z\n`])).toEqual([
    line,
    "[oversized stderr diagnostic]",
  ]);
});

test("an unterminated last stderr line is reported as written", async () => {
  expect(await stderrLines(["done\npartial\r"])).toEqual(["done", "partial\r"]);
});

test("the stderr excerpt keeps four scrubbed lines and the process log records them", async () => {
  const secret = "sk-abcdef123456";
  const { result, records } = await captureDaemonLogs(async () => {
    const encoder = new TextEncoder();
    const closed = Promise.withResolvers<void>();
    const chunks = [
      "\n",
      "line one should not be kept\n",
      "Usage limit reached\n",
      `token=${secret}\n`,
      "line four\n",
      "line five\n",
    ];
    const tree = {
      child: {
        pid: 1,
        exited: Promise.resolve(1),
        exitCode: 1,
        stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
        stdout: { async *[Symbol.asyncIterator]() {} },
        stderr: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield encoder.encode(chunk);
          },
        },
        kill: () => undefined,
      },
      terminate: async () => undefined,
      waitForExit: async () => true,
    } satisfies OwnedProcessTree;
    const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
    process.onClose(() => closed.resolve());
    try {
      await closed.promise;
      return process.stderrExcerpt();
    } finally {
      await process.dispose();
    }
  });
  // The excerpt is the stderr tail: the earliest lines fall out first, a secret inside the
  // tail is still scrubbed.
  const excerpt = "Usage limit reached\ntoken=[REDACTED]\nline four\nline five";
  expect(result).toBe(excerpt);
  expect(result).not.toContain(secret);
  expect(result).not.toContain("line one");
  const logged = records.find((record) => record.properties.event === "code_agent.process.stderr");
  expect(logged?.properties.error_message).toBe(excerpt);
  expect(JSON.stringify(logged?.properties)).not.toContain(secret);
});

/** The reported stderr lines and the captured log record of a process that writes `lines`. */
async function stderrLog(lines: readonly string[]) {
  return captureDaemonLogs(async () => {
    const encoder = new TextEncoder();
    const closed = Promise.withResolvers<void>();
    const tree = {
      child: {
        pid: 1,
        exited: Promise.resolve(1),
        exitCode: 1,
        stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
        stdout: { async *[Symbol.asyncIterator]() {} },
        stderr: {
          async *[Symbol.asyncIterator]() {
            for (const line of lines) yield encoder.encode(`${line}\n`);
          },
        },
        kill: () => undefined,
      },
      terminate: async () => undefined,
      waitForExit: async () => true,
    } satisfies OwnedProcessTree;
    const process = new JsonlProcess(["unused"], tmpdir(), {}, { spawn: () => tree });
    const received: string[] = [];
    process.onStderr((line) => received.push(line));
    process.onClose(() => closed.resolve());
    try {
      await closed.promise;
      return received;
    } finally {
      await process.dispose();
    }
  });
}

test("a stderr flood is logged as its head, an omitted count and its tail", async () => {
  const secret = "sk-abcdef123456";
  const lines = Array.from({ length: 210 }, (_, index) => `flood line ${index + 1}`);
  lines[4] = `token=${secret}`;
  lines[120] = `token=${secret}`;
  const { result, records } = await stderrLog(lines);
  // Listeners still see every reported line; only the process log is bounded.
  expect(result).toEqual(lines);
  const logged = records.find((record) => record.properties.event === "code_agent.process.stderr");
  expect(logged?.properties.lines).toBe(210);
  const kept = String(logged?.properties.stderr).split("\n");
  expect(kept).toHaveLength(151);
  expect(kept.slice(0, 100)).toEqual(
    lines.slice(0, 100).map((line) => line.replace(`token=${secret}`, "token=[REDACTED]")),
  );
  expect(kept[100]).toBe("[60 stderr lines omitted]");
  expect(kept.slice(101)).toEqual(lines.slice(160));
  expect(JSON.stringify(logged?.properties)).not.toContain(secret);
});

test("a stderr flood inside the head-and-tail budget keeps every line", async () => {
  const lines = Array.from({ length: 140 }, (_, index) => `line ${index + 1}`);
  const { records } = await stderrLog(lines);
  const logged = records.find((record) => record.properties.event === "code_agent.process.stderr");
  expect(String(logged?.properties.stderr).split("\n")).toEqual(lines);
});

test("a stderr flood a few lines over the budget omits only the middle", async () => {
  const lines = Array.from({ length: 160 }, (_, index) => `line ${index + 1}`);
  const { records } = await stderrLog(lines);
  const logged = records.find((record) => record.properties.event === "code_agent.process.stderr");
  const kept = String(logged?.properties.stderr).split("\n");
  expect(kept).toHaveLength(151);
  expect(kept.slice(0, 100)).toEqual(lines.slice(0, 100));
  expect(kept[100]).toBe("[10 stderr lines omitted]");
  expect(kept.slice(101)).toEqual(lines.slice(110));
});
