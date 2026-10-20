import { expect, test } from "bun:test";
import { jobPlist } from "#src/platform/launchd-job";
import { workspaceLaunchdJob } from "#src/supervisor/launchd-workspace-instance";
import {
  WORKSPACE_RELAUNCH_SECONDS,
  type WorkspaceInstanceConfig,
} from "#src/supervisor/workspace-instance";

const config: WorkspaceInstanceConfig = {
  stateRoot: "/state",
  workspaceId: "workspace-a",
  executablePath: "/opt/coforge-computer",
  socketPath: "/state/a/daemon.sock",
  stateDirectory: "/state/a",
  unitDirectory: "/state/launchd-workspaces",
};

test("every platform relaunches a crashed Workspace within one second", () => {
  expect(WORKSPACE_RELAUNCH_SECONDS).toBe(1);
});

test("launchd relaunches a crashed Workspace job at most once per shared relaunch bound", () => {
  const plist = jobPlist(workspaceLaunchdJob(config));
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).toContain(
    `<key>ThrottleInterval</key><integer>${WORKSPACE_RELAUNCH_SECONDS}</integer>`,
  );
});
