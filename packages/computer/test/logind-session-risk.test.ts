import { expect, test } from "bun:test";
import { detectLogindSessionRisk, formatLogindSessionRisk } from "#src/logind-session-risk";

test("logind risk is silent off Linux and when the process is outside a user session", async () => {
  let calls = 0;
  const deps = {
    platform: "darwin",
    readCgroup: async () => {
      calls++;
      return "0::/user.slice/user-1000.slice/session-1.scope";
    },
    run: async () => ({ code: 0, stdout: "b true" }),
  };
  expect(await detectLogindSessionRisk(deps)).toBeNull();
  expect(calls).toBe(0);
  expect(
    await detectLogindSessionRisk({
      platform: "linux",
      readCgroup: async () => "0::/system.slice/coforge.service",
      run: async () => ({ code: 0, stdout: "b true" }),
    }),
  ).toBeNull();
});

test("logind risk checks KillUserProcesses and user filters before reading linger", async () => {
  const calls: Array<[string, string[]]> = [];
  const result = await detectLogindSessionRisk({
    platform: "linux",
    uid: 1000,
    user: "alice",
    readCgroup: async () => "0::/user.slice/user-1000.slice/session-7.scope",
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === "busctl" && args.at(-1) === "KillUserProcesses")
        return { code: 0, stdout: "b true" };
      if (command === "busctl" && args.at(-1) === "KillExcludeUsers")
        return { code: 0, stdout: "as 0" };
      if (command === "busctl" && args.at(-1) === "KillOnlyUsers")
        return { code: 0, stdout: 'as 1 "alice"' };
      return { code: 0, stdout: "yes\n" };
    },
  });
  expect(result).toEqual({ sessionScope: "session-7.scope", user: "alice", linger: true });
  expect(calls.at(-1)).toEqual(["loginctl", ["show-user", "alice", "-p", "Linger", "--value"]]);
});

test("logind risk ignores another user's cgroup and failed probes", async () => {
  const run = async () => ({ code: 1, stdout: "" });
  expect(
    await detectLogindSessionRisk({
      platform: "linux",
      uid: 1001,
      readCgroup: async () => "0::/user.slice/user-1000.slice/session-7.scope",
      run,
    }),
  ).toBeNull();
  expect(
    await detectLogindSessionRisk({
      platform: "linux",
      uid: 1000,
      user: "alice",
      readCgroup: async () => "0::/user.slice/user-1000.slice/session-7.scope",
      run,
    }),
  ).toBeNull();
});

test("logind warning explains the risk and both remedies", () => {
  const lines = formatLogindSessionRisk({
    sessionScope: "session-7.scope",
    user: "alice",
    linger: false,
  });
  expect(lines.join("\n")).toContain("KillUserProcesses=yes");
  expect(lines.join("\n")).toContain("loginctl enable-linger alice");
  expect(lines.join("\n")).toContain("systemd-run --user --unit=coforge-computer");
});
