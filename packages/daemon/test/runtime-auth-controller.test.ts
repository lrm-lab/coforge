import { expect, test } from "bun:test";
import type {
  RuntimeAuthAdapter,
  RuntimeAuthLoginInteraction,
  RuntimeAuthLoginResult,
} from "@lrm/coforge-anvil";
import {
  decodeRuntimeAuthLoginReport,
  encodeRuntimeAuthLoginReport,
  type RuntimeAuthLoginReport,
} from "@lrm/coforge-sdk/internal";
import { RuntimeAuthController } from "#src/daemon-runtime/runtime-auth-controller";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-a", computerId: "computer-a" };
const loginId = "rtl_abcdefghijklmnop";

test("a Codex login reports ordered private device progress and a masked account, then refreshes status", async () => {
  const reports: RuntimeAuthLoginReport[] = [];
  let refreshed = 0;
  const adapter: RuntimeAuthAdapter = {
    provider: "codex",
    async startLogin(options, interaction) {
      expect(options.workingDirectory).toBe("/fixture");
      interaction.onEvent({
        kind: "device_code",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAtMs: 61_000,
      });
      return {
        status: "logged_in",
        authStatus: {
          provider: "codex",
          state: "logged_in",
          account: { maskedLabel: "u****@example.com", planLabel: "pro" },
        },
      };
    },
    async readStatus() {
      return { provider: "codex", state: "logged_in" };
    },
    async submitCode() {
      throw new Error("Codex uses device code");
    },
    async cancel() {},
    async logout() {
      return { status: "logged_out", authStatus: { provider: "codex", state: "logged_out" } };
    },
  };
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(report)));
    },
    reportLogout: async () => {},
    refresh: async () => {
      refreshed++;
    },
    now: () => 1_000,
  });
  await controller.handle({ ...scope, kind: "login_start", loginId, provider: "codex" });
  expect(reports).toEqual([
    {
      ...scope,
      loginId,
      sequence: 1,
      event: {
        kind: "device_code",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 60,
      },
    },
    {
      ...scope,
      loginId,
      sequence: 2,
      result: {
        kind: "logged_in",
        account: { maskedLabel: "u****@example.com", planLabel: "pro" },
      },
    },
  ]);
  expect(refreshed).toBe(1);
});

test("Claude accepts code only for its current prompt, reports retry and removes secret echoes", async () => {
  const reports: RuntimeAuthLoginReport[] = [];
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const received: string[] = [];
  const adapter = fakeAdapter(async (options, interaction) => {
    options.onSecret?.("provider-secret-sentinel");
    interaction.onEvent({
      kind: "auth_url",
      verificationUrl: "https://claude.com/oauth/authorize?state=private-state",
    });
    interaction.onEvent({ kind: "code_prompt", message: "Paste code" });
    const code = interaction.prompt({ kind: "manual_code", message: "Paste code" });
    first.resolve();
    received.push(await code);
    interaction.onEvent({
      kind: "info",
      message: "Rejected pasted-sentinel#state-sentinel provider-secret-sentinel",
    });
    interaction.onEvent({ kind: "code_prompt", message: "Try again" });
    const retry = interaction.prompt({ kind: "manual_code", message: "Try again" });
    second.resolve();
    received.push(await retry);
    return {
      status: "failed",
      reason: "rejected",
      detail: "pasted-sentinel#state-sentinel provider-secret-sentinel",
    };
  });
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(report)));
    },
    reportLogout: async () => {},
    refresh: async () => {},
  });
  await controller.handle({ ...scope, kind: "login_code", loginId, code: "early-drop" });
  const pending = controller.handle({
    ...scope,
    kind: "login_start",
    loginId,
    provider: "claude-code",
  });
  try {
    await first.promise;
    await controller.handle({
      ...scope,
      kind: "login_code",
      loginId: "rtl_otherabcdefghijklmnop",
      code: "wrong-drop",
    });
    await controller.handle({
      ...scope,
      kind: "login_code",
      loginId,
      code: "pasted-sentinel#state-sentinel",
    });
    await second.promise;
    await controller.handle({
      ...scope,
      kind: "login_code",
      loginId,
      code: "second-code-sentinel",
    });
    await pending;
    expect(received).toEqual(["pasted-sentinel#state-sentinel", "second-code-sentinel"]);
    expect(reports.map((report) => report.event ?? report.result)).toEqual([
      { kind: "auth_url", url: "https://claude.com/oauth/authorize?state=private-state" },
      { kind: "code_prompt", message: "Paste code", retry: false },
      { kind: "info", message: "Rejected [redacted] [redacted]" },
      { kind: "code_prompt", message: "Try again", retry: true },
      { kind: "failed", reason: "rejected" },
    ]);
    expect(JSON.stringify(reports)).not.toContain("sentinel");
    await controller.handle({ ...scope, kind: "login_code", loginId, code: "late-drop" });
  } finally {
    await controller.handle({ ...scope, kind: "login_cancel", loginId });
    await pending;
  }
});

function fakeAdapter(
  startLogin: RuntimeAuthAdapter["startLogin"],
  provider: "claude-code" | "codex" = "claude-code",
): RuntimeAuthAdapter {
  return {
    provider,
    startLogin,
    readStatus: async () => ({ provider, state: "logged_out" }),
    submitCode: async () => {
      throw new Error("Use interaction.prompt");
    },
    cancel: async () => {
      throw new Error("Use interaction.signal");
    },
    logout: async () => ({ status: "logged_out", authStatus: { provider, state: "logged_out" } }),
  };
}

test("deduplicates a login id and refuses another login for the same provider until cleanup completes", async () => {
  const ready = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<RuntimeAuthLoginResult>();
  let starts = 0;
  const reports: RuntimeAuthLoginReport[] = [];
  const adapter = fakeAdapter(async () => {
    starts++;
    ready.resolve();
    return complete.promise;
  });
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(report);
    },
    reportLogout: async () => {},
    refresh: async () => {},
  });
  const start = {
    ...scope,
    kind: "login_start" as const,
    loginId,
    provider: "claude-code" as const,
  };
  const pending = controller.handle(start);
  let duplicate: Promise<void> | undefined;
  try {
    await ready.promise;
    duplicate = controller.handle(start);
    const other = controller.handle({ ...start, loginId: "rtl_secondabcdefghijklmn" });
    complete.resolve({ status: "cancelled" });
    await Promise.all([pending, duplicate, other]);
    expect(starts).toBe(1);
    expect(reports).toContainEqual({
      ...scope,
      loginId: "rtl_secondabcdefghijklmn",
      sequence: 1,
      result: { kind: "busy" },
    });
  } finally {
    complete.resolve({ status: "cancelled" });
    await Promise.all([pending, duplicate]);
  }
  await controller.handle(start);
  expect(starts).toBe(1);
  expect(reports.filter((report) => report.loginId === loginId)).toHaveLength(1);
});

test("refuses another Workspace or Computer before invoking an adapter", async () => {
  let starts = 0;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () =>
      fakeAdapter(async () => {
        starts++;
        return { status: "cancelled" };
      }),
    reportLogin: async () => {
      throw new Error("Must not report another scope");
    },
    reportLogout: async () => {
      throw new Error("Must not report another scope");
    },
    refresh: async () => {},
  });
  await controller.handle({
    ...scope,
    workspaceId: "workspace-other",
    kind: "login_start",
    loginId,
    provider: "codex",
  });
  await controller.handle({
    ...scope,
    computerId: "computer-other",
    kind: "login_start",
    loginId,
    provider: "codex",
  });
  expect(starts).toBe(0);
});

test("stop aborts the current prompt and fences late progress, reports, refresh and new work", async () => {
  const ready = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const reports: RuntimeAuthLoginReport[] = [];
  let refreshed = 0;
  let starts = 0;
  let events: RuntimeAuthLoginInteraction | undefined;
  const adapter = fakeAdapter(async (_, interaction) => {
    starts++;
    events = interaction;
    interaction.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    const prompt = interaction.prompt({ kind: "manual_code" });
    ready.resolve();
    await Promise.race([prompt.catch(() => {}), cleanup.promise]);
    await cleanup.promise;
    return { status: "cancelled" };
  });
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(report);
    },
    reportLogout: async () => {},
    refresh: async () => {
      refreshed++;
    },
  });
  const pending = controller.handle({
    ...scope,
    kind: "login_start",
    loginId,
    provider: "claude-code",
  });
  try {
    await ready.promise;
    controller.stop();
    await aborted.promise;
    const count = reports.length;
    events!.onEvent({ kind: "info", message: "late event" });
    await controller.handle({ ...scope, kind: "login_code", loginId, code: "late-secret" });
    await controller.handle({
      ...scope,
      kind: "login_start",
      loginId: "rtl_secondabcdefghijklmn",
      provider: "codex",
    });
    cleanup.resolve();
    await pending;
    expect(starts).toBe(1);
    expect(reports).toHaveLength(count);
    expect(refreshed).toBe(0);
  } finally {
    cleanup.resolve();
    await pending;
  }
});

test("logout cancels and awaits login cleanup, excludes new login, and deduplicates its request", async () => {
  const ready = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const logoutStarted = Promise.withResolvers<void>();
  const logoutDone = Promise.withResolvers<void>();
  const order: string[] = [];
  const logouts: unknown[] = [];
  const reports: RuntimeAuthLoginReport[] = [];
  const adapter = fakeAdapter(async (_, interaction) => {
    interaction.signal!.addEventListener(
      "abort",
      () => {
        order.push("abort");
        aborted.resolve();
      },
      { once: true },
    );
    ready.resolve();
    await cleanup.promise;
    order.push("login cleaned");
    return { status: "cancelled" };
  });
  adapter.logout = async () => {
    order.push("logout");
    logoutStarted.resolve();
    await logoutDone.promise;
    return { status: "logged_out", authStatus: { provider: "claude-code", state: "logged_out" } };
  };
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => adapter,
    reportLogin: async (report) => {
      reports.push(report);
    },
    reportLogout: async (report) => {
      logouts.push(report);
    },
    refresh: async () => {},
  });
  const login = controller.handle({
    ...scope,
    kind: "login_start",
    loginId,
    provider: "claude-code",
  });
  let logout: Promise<void> | undefined;
  const request = {
    ...scope,
    kind: "logout" as const,
    requestId: "logout-request-1",
    provider: "claude-code" as const,
  };
  try {
    await ready.promise;
    logout = controller.handle(request);
    await Promise.race([aborted.promise, logout]);
    expect(order).toEqual(["abort"]);
    cleanup.resolve();
    await logoutStarted.promise;
    await controller.handle({
      ...scope,
      kind: "login_start",
      loginId: "rtl_secondabcdefghijklmn",
      provider: "claude-code",
    });
    expect(reports.at(-1)?.result).toEqual({ kind: "busy" });
    logoutDone.resolve();
    await Promise.all([login, logout]);
    await controller.handle(request);
    expect(order).toEqual(["abort", "login cleaned", "logout"]);
    expect(logouts).toEqual([
      { ...scope, requestId: "logout-request-1", result: { kind: "logged_out" } },
    ]);
  } finally {
    cleanup.resolve();
    logoutDone.resolve();
    await Promise.allSettled([login, logout]);
    controller.stop();
  }
});

for (const event of [
  { kind: "device_code", userCode: "ABCD-EFGH", expiresAtMs: 61_000 },
  {
    kind: "device_code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAtMs: 0,
  },
  { kind: "auth_url", verificationUrl: "http://untrusted.invalid/login" },
] satisfies import("@lrm/coforge-anvil").RuntimeAuthLoginEvent[]) {
  test(`invalid ${event.kind} progress fails safely even if the provider claims success`, async () => {
    const reports: RuntimeAuthLoginReport[] = [];
    const adapter = fakeAdapter(async (_, interaction) => {
      interaction.onEvent(event);
      return { status: "logged_in", authStatus: { provider: "codex", state: "logged_in" } };
    }, "codex");
    const controller = new RuntimeAuthController({
      owner: scope,
      workingDirectory: "/fixture",
      createAdapter: () => adapter,
      reportLogin: async (report) => {
        reports.push(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(report)));
      },
      reportLogout: async () => {},
      refresh: async () => {},
      now: () => 1_000,
    });
    await controller.handle({ ...scope, kind: "login_start", loginId, provider: "codex" });
    expect(reports).toEqual([
      { ...scope, loginId, sequence: 1, result: { kind: "failed", reason: "interaction_failed" } },
    ]);
  });
}

test("reports remain in sequence across a slow RPC, and no event can follow the terminal result", async () => {
  const entered = Promise.withResolvers<void>();
  const accept = Promise.withResolvers<void>();
  const reports: RuntimeAuthLoginReport[] = [];
  let interaction: RuntimeAuthLoginInteraction | undefined;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () =>
      fakeAdapter(async (_, value) => {
        interaction = value;
        value.onEvent({ kind: "info", message: "Signing in" });
        return { status: "cancelled" };
      }),
    reportLogin: async (report) => {
      reports.push(report);
      if (report.sequence === 1) {
        entered.resolve();
        await accept.promise;
      }
    },
    reportLogout: async () => {},
    refresh: async () => {},
  });
  const pending = controller.handle({
    ...scope,
    kind: "login_start",
    loginId,
    provider: "claude-code",
  });
  try {
    await entered.promise;
    expect(reports.map((report) => report.sequence)).toEqual([1]);
    accept.resolve();
    await pending;
    interaction!.onEvent({ kind: "info", message: "late progress" });
    expect(reports.map((report) => report.sequence)).toEqual([1, 2]);
    expect(reports[1]?.result).toEqual({ kind: "cancelled" });
  } finally {
    accept.resolve();
    await pending;
    controller.stop();
  }
});

test("a stop while logout's report is in flight prevents its later status refresh", async () => {
  const entered = Promise.withResolvers<void>();
  const accept = Promise.withResolvers<void>();
  let refreshed = 0;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () => fakeAdapter(async () => ({ status: "cancelled" })),
    reportLogin: async () => {},
    reportLogout: async () => {
      entered.resolve();
      await accept.promise;
    },
    refresh: async () => {
      refreshed++;
    },
  });
  const pending = controller.handle({
    ...scope,
    kind: "logout",
    requestId: "logout-1",
    provider: "claude-code",
  });
  try {
    await entered.promise;
    controller.stop();
    accept.resolve();
    await pending;
    expect(refreshed).toBe(0);
  } finally {
    accept.resolve();
    await pending;
    controller.stop();
  }
});

test("an unencodable terminal result falls back safely and releases the provider for another login", async () => {
  const reports: RuntimeAuthLoginReport[] = [];
  let starts = 0;
  const controller = new RuntimeAuthController({
    owner: scope,
    workingDirectory: "/fixture",
    createAdapter: () =>
      fakeAdapter(async () => {
        starts++;
        if (starts === 1)
          return {
            status: "failed",
            reason: "invalid-sentinel-reason",
          } as unknown as RuntimeAuthLoginResult;
        return { status: "cancelled" };
      }),
    reportLogin: async (report) => {
      reports.push(report);
    },
    reportLogout: async () => {},
    refresh: async () => {},
  });
  try {
    await expect(
      controller.handle({ ...scope, kind: "login_start", loginId, provider: "claude-code" }),
    ).resolves.toBeUndefined();
    await controller.handle({
      ...scope,
      kind: "login_start",
      loginId: "rtl_secondabcdefghijklmn",
      provider: "claude-code",
    });
    expect(starts).toBe(2);
    expect(reports.map((report) => report.result)).toEqual([
      { kind: "failed", reason: "process_failed" },
      { kind: "cancelled" },
    ]);
    expect(JSON.stringify(reports)).not.toContain("invalid-sentinel-reason");
  } finally {
    controller.stop();
  }
});
