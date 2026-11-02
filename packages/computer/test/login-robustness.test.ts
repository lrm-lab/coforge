import { expect, test } from "bun:test";
import pc from "picocolors";

import { ComputerLogin, type DeviceAuthorizationClient } from "#src/login";
import {
  describeNetworkError,
  isTransientNetworkError,
  NETWORK_FAILURE_HINT,
} from "#src/network-error";
import { writeSetupResult } from "#src/cli/setup-output";

const config = {
  async saveCurrentProfile() {},
};

test("isTransientNetworkError identifies network and socket errors across cause chains", () => {
  expect(isTransientNetworkError(new Error("connect ECONNRESET"))).toBe(true);
  expect(isTransientNetworkError({ code: "ECONNRESET" })).toBe(true);
  expect(isTransientNetworkError({ code: "ETIMEDOUT" })).toBe(true);
  expect(isTransientNetworkError({ code: "UND_ERR_SOCKET" })).toBe(true);
  expect(
    isTransientNetworkError(
      new Error("fetch failed", { cause: { code: "ECONNRESET", cause: { name: "TimeoutError" } } }),
    ),
  ).toBe(true);
  expect(isTransientNetworkError(new Error("invalid password"))).toBe(false);
});

test("describeNetworkError joins codes and names across cause chains", () => {
  const err = new Error("fetch failed", {
    cause: { code: "ECONNRESET", cause: { code: "UND_ERR_SOCKET" } },
  });
  expect(describeNetworkError(err)).toBe("ECONNRESET/UND_ERR_SOCKET");
});

test("断一次仍然登录成功：轮询期间遇到一次临时网络错误，下次成功时照常完成登录并重置失败计数", async () => {
  let polls = 0;
  const sleeps: number[] = [];
  const saved: unknown[] = [];

  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    async pollToken() {
      polls += 1;
      if (polls === 1) {
        // First poll: transient network disconnect
        const error = new Error("fetch failed", {
          cause: { code: "ECONNRESET" },
        });
        throw error;
      }
      return {
        status: "authorized",
        credential: { accessToken: "access-token-123", tokenType: "Bearer" },
      };
    },
  };

  const output: string[] = [];
  const result = await new ComputerLogin({
    client,
    store: {
      async save(_serverUrl, cred) {
        saved.push(cred);
      },
    },
    config,
    writeLine: (line) => output.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    openVerificationPage: async () => undefined,
    colors: pc.createColors(false),
  }).run({ serverUrl: "https://coforge.example", json: false });

  expect(result.serverUrl).toBe("https://coforge.example");
  expect(polls).toBe(2);
  expect(saved).toEqual([{ accessToken: "access-token-123", tokenType: "Bearer" }]);
  // After a failure, interval backs off by 5s (5000 initial + 5000 backoff = 10000)
  expect(sleeps).toEqual([5_000, 10_000]);
});

test("连续断够次数后失败，并说明原因：连续 5 次网络错误后立即抛出 AUTH_NETWORK_ERROR 并带原因和代理提示", async () => {
  let polls = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    async pollToken() {
      polls += 1;
      const error = new Error("fetch failed", {
        cause: { code: "ECONNRESET", cause: { code: "UND_ERR_SOCKET" } },
      });
      throw error;
    },
  };

  const login = new ComputerLogin({
    client,
    store: { async save() {} },
    config,
    writeLine: () => undefined,
    sleep: async () => undefined,
    openVerificationPage: async () => undefined,
  });

  const failure = await login.run({ serverUrl: "https://hub.coforge.example" }).catch((err) => err);

  expect(polls).toBe(5);
  expect(failure.code).toBe("AUTH_NETWORK_ERROR");
  expect(failure.message).toContain(
    "Lost connection to hub.coforge.example while waiting for approval",
  );
  expect(failure.message).toContain("ECONNRESET/UND_ERR_SOCKET");
  expect(failure.message).toContain(NETWORK_FAILURE_HINT);
  expect(failure.message).toContain("coforge-computer login");
});

test("等待批准期间断网并在超时到达时，报错为网络错误说明原因，而非超时", async () => {
  let now = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 20,
        intervalSeconds: 5,
      };
    },
    async pollToken() {
      now += 10_000;
      throw new Error("fetch failed", {
        cause: { code: "ETIMEDOUT" },
      });
    },
  };

  const login = new ComputerLogin({
    client,
    store: { async save() {} },
    config,
    writeLine: () => undefined,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    openVerificationPage: async () => undefined,
  });

  const failure = await login.run({ serverUrl: "https://coforge.example" }).catch((err) => err);

  expect(failure.code).toBe("AUTH_NETWORK_ERROR");
  expect(failure.message).toContain("ETIMEDOUT");
  expect(failure.message).toContain("Lost connection");
});

test("中间成功响应会重置连续错误计数", async () => {
  let polls = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    async pollToken() {
      polls += 1;
      // 1..4 fail, 5 succeeds (pending), 6 succeeds (authorized)
      if (polls <= 4) {
        throw new Error("connect ECONNREFUSED", { cause: { code: "ECONNREFUSED" } });
      }
      if (polls === 5) {
        return { status: "pending" };
      }
      return {
        status: "authorized",
        credential: { accessToken: "token-recovered", tokenType: "Bearer" },
      };
    },
  };

  const login = new ComputerLogin({
    client,
    store: { async save() {} },
    config,
    writeLine: () => undefined,
    sleep: async () => undefined,
    openVerificationPage: async () => undefined,
  });

  const result = await login.run({ serverUrl: "https://coforge.example" });
  expect(result.serverUrl).toBe("https://coforge.example");
  expect(polls).toBe(6);
});

test("setup 结束输出直接打开 server 对应 Workspace 的链接", () => {
  const lines: string[] = [];
  const result = {
    workspace: { id: "w-1", name: "Demo Workspace", slug: "demo" },
    configPath: "/path/to/config.json",
    serverUrl: "https://app.coforge.example",
  };

  writeSetupResult((line) => lines.push(line), result, false);

  expect(lines).toContain("Server:                https://app.coforge.example/w/demo");

  // JSON output
  const jsonLines: string[] = [];
  writeSetupResult((line) => jsonLines.push(line), result, true);
  const parsed = JSON.parse(jsonLines[0]!);
  expect(parsed.server_url).toBe("https://app.coforge.example");
  expect(parsed.workspace_url).toBe("https://app.coforge.example/w/demo");
});
