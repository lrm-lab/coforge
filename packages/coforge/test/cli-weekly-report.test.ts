import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs, run } from "../index";

test("weekly-report-collect CLI parses submit-pack and dispatches the transport", async () => {
  const packPath = `${tmpdir()}/coforge-collect-pack-${crypto.randomUUID()}.md`;
  await Bun.write(packPath, "# pack\n");
  try {
    const invocation = parseArgs([
      "weekly-report-collect",
      "submit-pack",
      "--run-id",
      "22222222-2222-4222-8222-222222222222",
      "--idempotency-key",
      "11111111-1111-4111-8111-111111111111",
      "--markdown",
      packPath,
    ]);
    expect(invocation).toEqual({
      command: "weekly-report-collect",
      markdownPath: packPath,
      collect: {
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
        outcome: "ready",
      },
    });
    const calls: unknown[] = [];
    const output = await run(
      [
        "weekly-report-collect",
        "submit-empty",
        "--run-id",
        "22222222-2222-4222-8222-222222222222",
        "--idempotency-key",
        "11111111-1111-4111-8111-111111111111",
      ],
      {
        check: async () => {
          throw new Error("message check called");
        },
        read: async () => {
          throw new Error("message read called");
        },
        send: async () => {
          throw new Error("message send called");
        },
        view: async () => {
          throw new Error("attachment view called");
        },
        weeklyReportCollect: async (command) => {
          calls.push(command);
          return {
            idempotencyKey: command.idempotencyKey,
            runId: command.runId,
            status: "cancelled",
            allTerminal: true,
            canSynthesize: false,
            newlyAccepted: calls.length === 1,
            replayed: calls.length > 1,
            slotStatus: calls.length === 1 ? "empty" : "ready",
            waveExhausted: calls.length === 1,
          };
        },
      },
    );
    expect(calls).toEqual([
      {
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
        outcome: "empty",
      },
    ]);
    // An accepted submit-empty that exhausts the wave closes the run in the same call; the
    // message says the slot report landed and what the run does next — never the run's
    // "cancelled" status or internal field names an Agent would misread as a rejection (#695).
    expect(output).toBe(
      "Collect empty accepted. This collect run is closed: no usable pack was collected. Nothing else to do.",
    );
    expect(output).not.toContain("cancelled");
    expect(output).not.toContain("allTerminal");
    expect(output).not.toContain("canSynthesize");

    const rejected = await run(
      [
        "weekly-report-collect",
        "submit-pack",
        "--run-id",
        "22222222-2222-4222-8222-222222222222",
        "--idempotency-key",
        "99999999-9999-4999-8999-999999999999",
        "--markdown",
        packPath,
      ],
      {
        check: async () => {
          throw new Error("message check called");
        },
        read: async () => {
          throw new Error("message read called");
        },
        send: async () => {
          throw new Error("message send called");
        },
        view: async () => {
          throw new Error("attachment view called");
        },
        weeklyReportCollect: async (command) => ({
          idempotencyKey: command.idempotencyKey,
          runId: command.runId,
          status: "collecting",
          allTerminal: false,
          canSynthesize: false,
          newlyAccepted: false,
          slotStatus: "ready",
        }),
      },
    );
    expect(rejected).toBe("Collect submit not accepted: the slot already settled as ready.");

    // A requestId replay of the same outcome is not a rejection: the earlier submit already
    // landed, so the Agent reads "already accepted", not "not accepted".
    const replayed = await run(
      [
        "weekly-report-collect",
        "submit-empty",
        "--run-id",
        "22222222-2222-4222-8222-222222222222",
        "--idempotency-key",
        "11111111-1111-4111-8111-111111111111",
      ],
      {
        check: async () => {
          throw new Error("message check called");
        },
        read: async () => {
          throw new Error("message read called");
        },
        send: async () => {
          throw new Error("message send called");
        },
        view: async () => {
          throw new Error("attachment view called");
        },
        weeklyReportCollect: async (command) => ({
          idempotencyKey: command.idempotencyKey,
          runId: command.runId,
          status: "cancelled",
          allTerminal: true,
          canSynthesize: false,
          newlyAccepted: false,
          replayed: true,
          slotStatus: "empty",
        }),
      },
    );
    expect(replayed).toBe("Collect submit already accepted earlier; the slot is empty.");
    expect(replayed).not.toContain("not accepted");
    expect(replayed).not.toContain("cancelled");
  } finally {
    await rm(packPath, { force: true });
  }
});

test("weekly-report-collect CLI says what a ready pack sets in motion", async () => {
  const packPath = `${tmpdir()}/coforge-collect-pack-inline-${crypto.randomUUID()}.md`;
  await Bun.write(packPath, "# pack\n");
  try {
    const output = await run(
      [
        "weekly-report-collect",
        "submit-pack",
        "--run-id",
        "22222222-2222-4222-8222-222222222222",
        "--idempotency-key",
        "11111111-1111-4111-8111-111111111111",
        "--markdown",
        packPath,
      ],
      {
        check: async () => {
          throw new Error("message check called");
        },
        read: async () => {
          throw new Error("message read called");
        },
        send: async () => {
          throw new Error("message send called");
        },
        view: async () => {
          throw new Error("attachment view called");
        },
        weeklyReportCollect: async (command) => ({
          idempotencyKey: command.idempotencyKey,
          runId: command.runId,
          status: "synthesizing",
          allTerminal: true,
          canSynthesize: true,
          newlyAccepted: true,
          replayed: false,
          slotStatus: "ready",
          synthesisStarted: true,
          waveExhausted: false,
        }),
      },
    );
    expect(output).toBe("Collect ready accepted. The weekly report is now being written.");
  } finally {
    await rm(packPath, { force: true });
  }
});

test("weekly-report-memory CLI loads the settlement file and dispatches the transport", async () => {
  const filePath = `${tmpdir()}/coforge-memory-${crypto.randomUUID()}.json`;
  const reportId = "66666666-6666-4666-8666-666666666666";
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  await Bun.write(
    filePath,
    JSON.stringify({
      year: 2026,
      week: 40,
      preferences: ["  先写结果  "],
      explicitRules: [{ statement: "以后都先写结果", effect: "adopt" }],
      factCorrections: [],
      threads: [{ title: "登录改造", status: "open" }],
    }),
  );
  try {
    const invocation = parseArgs([
      "weekly-report-memory",
      "submit",
      "--report-id",
      reportId,
      "--idempotency-key",
      idempotencyKey,
      "--file",
      filePath,
    ]);
    expect(invocation).toEqual({
      command: "weekly-report-memory",
      filePath,
      memory: { idempotencyKey, reportId },
    });
    const calls: unknown[] = [];
    const output = await run(
      [
        "weekly-report-memory",
        "submit",
        "--report-id",
        reportId,
        "--idempotency-key",
        idempotencyKey,
        "--file",
        filePath,
      ],
      {
        check: async () => {
          throw new Error("message check called");
        },
        read: async () => {
          throw new Error("message read called");
        },
        send: async () => {
          throw new Error("message send called");
        },
        view: async () => {
          throw new Error("attachment view called");
        },
        weeklyReportMemory: async (command) => {
          calls.push(command);
          return {
            idempotencyKey: command.idempotencyKey,
            reportId: command.reportId,
            status: "saved",
          };
        },
      },
    );
    expect(calls).toEqual([
      {
        idempotencyKey,
        reportId,
        year: 2026,
        week: 40,
        preferences: ["先写结果"],
        explicitRules: [{ statement: "以后都先写结果", effect: "adopt" }],
        factCorrections: [],
        threads: [{ title: "登录改造", status: "open" }],
      },
    ]);
    expect(output).toBe(`Memory saved (report ${reportId}).`);
  } finally {
    await rm(filePath, { force: true });
  }
});

test("weekly-report CLI parses bounded reads and dispatches the transport", async () => {
  const invocation = parseArgs([
    "weekly-report",
    "read",
    "--report-id",
    "33333333-3333-4333-8333-333333333333",
    "--section",
    "Progress",
    "--max-characters",
    "120",
  ]);
  expect(invocation).toEqual({
    command: "weekly-report",
    weeklyReport: {
      operation: "read",
      reportId: "33333333-3333-4333-8333-333333333333",
      section: "Progress",
      maxCharacters: 120,
    },
  });
  const calls: unknown[] = [];
  const output = await run(["weekly-report", "list", "--limit", "2"], {
    check: async () => {
      throw new Error("message check called");
    },
    read: async () => {
      throw new Error("message read called");
    },
    send: async () => {
      throw new Error("message send called");
    },
    view: async () => {
      throw new Error("attachment called");
    },
    weeklyReport: async (command) => {
      calls.push(command);
      return {
        idempotencyKey: "request",
        operation: "list",
        result: { reports: [], nextCursor: null },
      };
    },
  });
  expect(calls).toEqual([{ operation: "list", limit: 2 }]);
  expect(output).toEqual({
    idempotencyKey: "request",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
});

test("weekly-report CLI rejects oversized list limits", () => {
  expect(() => parseArgs(["weekly-report", "list", "--limit", "51"])).toThrow("Usage:");
});
