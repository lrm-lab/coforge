import { expect, test } from "bun:test";
import { isolatedTestEnvironment } from "./isolated-test-run";

/** The names a CoForge Agent's process (and its Workspace Daemon, or a cloud Computer container)
 * carries, spelled out here rather than read back from the list under test. */
const AGENT_AND_WORKSPACE_KEYS = [
  "COFORGE_AGENT_CONTEXT",
  "COFORGE_AGENT_CONVERSATION_TARGET",
  "COFORGE_AGENT_PROXY_URL",
  "COFORGE_DAEMON_SOCKET",
  "COFORGE_CURRENT_AGENT_ID",
  "COFORGE_CURRENT_AGENT_NAME",
  "COFORGE_CURRENT_WORKSPACE_ID",
  "COFORGE_CURRENT_WORKSPACE_SLUG",
  "COFORGE_CURRENT_WORKSPACE_NAME",
  "COFORGE_CURRENT_COMPUTER_ID",
  "COFORGE_CURRENT_COMPUTER_NAME",
  "COFORGE_CURRENT_COMPUTER_HOSTNAME",
  "COFORGE_CURRENT_COMPUTER_OS",
  "COFORGE_CURRENT_COMPUTER_VERSION",
  "COFORGE_CURRENT_AGENT_WORKSPACE_PATH",
  "COFORGE_GIT_CONFIG_BASE_COUNT",
  "COFORGE_WORKSPACE_AGENT_PREFIX",
  "COFORGE_WORKSPACE_JOB_DIRECTORY",
  "COFORGE_SUPERVISOR_SOCKET",
  "COFORGE_SUPERVISOR_STATE_PATH",
  "COFORGE_DAEMON_CONNECTION_ENDPOINT",
  "COFORGE_DAEMON_API_KEY",
  "COFORGE_WORKSPACE_ID",
  "COFORGE_WORKSPACE_SLUG",
  "COFORGE_COMPUTER_ID",
  "COFORGE_COMPUTER_NAME",
  "COFORGE_SERVER_URL",
];

test("a test run starts without the Agent's or the Workspace's CoForge variables", () => {
  const parent = Object.fromEntries(AGENT_AND_WORKSPACE_KEYS.map((key) => [key, `live-${key}`]));
  const daemonHome = "/private/var/folders/xy/coforge-test-daemon-home-1";
  const environment = isolatedTestEnvironment(
    { ...parent, COFORGE_DAEMON_HOME: "/Users/someone/.coforge/daemon/workspaces/a" },
    daemonHome,
  );
  expect(AGENT_AND_WORKSPACE_KEYS.filter((key) => key in environment)).toEqual([]);
  expect(environment.COFORGE_DAEMON_HOME).toBe(daemonHome);
});

test("a test run keeps ordinary variables and the test tooling's own CoForge config", () => {
  const ordinary = {
    HOME: "/Users/someone",
    PATH: "/usr/local/bin:/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-test",
    COFORGE_E2E_WEB_URL: "http://127.0.0.1:8789",
    COFORGE_CLI_DRAFT_STATE_DIR: "/tmp/drafts",
  };
  const environment = isolatedTestEnvironment(
    { ...ordinary, COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:4000" },
    "/tmp/home",
  );
  expect(environment).toEqual({ ...ordinary, COFORGE_DAEMON_HOME: "/tmp/home" });
});

/** What the Daemon gives an Agent whose git hooks run through a `core.hooksPath` shim
 * directory: the user's two entries, then five of the Daemon's own (`agentEnvironment`), with the
 * user's count kept in COFORGE_GIT_CONFIG_BASE_COUNT. */
const AGENT_GIT_CONFIG = {
  GIT_CONFIG_COUNT: "7",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Someone",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_3: "!coforge github credential",
  GIT_CONFIG_KEY_4: "credential.https://github.com.useHttpPath",
  GIT_CONFIG_VALUE_4: "true",
  GIT_CONFIG_KEY_5: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_5: "git@github.com:",
  GIT_CONFIG_KEY_6: "core.hooksPath",
  GIT_CONFIG_VALUE_6: "/Users/someone/.coforge/daemon/git-hooks",
};

test("a test run keeps the user's git config entries and drops the ones the Daemon added", () => {
  const environment = isolatedTestEnvironment(
    { ...AGENT_GIT_CONFIG, COFORGE_GIT_CONFIG_BASE_COUNT: "2" },
    "/tmp/home",
  );
  expect(Object.entries(environment).filter(([name]) => name.startsWith("GIT_CONFIG"))).toEqual([
    ["GIT_CONFIG_COUNT", "2"],
    ["GIT_CONFIG_KEY_0", "user.name"],
    ["GIT_CONFIG_VALUE_0", "Someone"],
    ["GIT_CONFIG_KEY_1", "commit.gpgsign"],
    ["GIT_CONFIG_VALUE_1", "false"],
  ]);
});

test("a test run has no git config entries when the Daemon added every one", () => {
  const environment = isolatedTestEnvironment(
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/Users/someone/.coforge/daemon/git-hooks",
      COFORGE_GIT_CONFIG_BASE_COUNT: "0",
    },
    "/tmp/home",
  );
  expect(Object.keys(environment).filter((name) => name.startsWith("GIT_CONFIG"))).toEqual([]);
});

test("a test run without a recorded base count keeps every git config entry", () => {
  const environment = isolatedTestEnvironment(AGENT_GIT_CONFIG, "/tmp/home");
  expect(environment).toEqual({ ...AGENT_GIT_CONFIG, COFORGE_DAEMON_HOME: "/tmp/home" });
});
