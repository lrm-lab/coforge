import { expect, test } from "bun:test";
import { AGENT_ACTIVITY_DETAIL_KIND, WORKSPACE_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import { ignoredAgentEnvironmentActivity } from "#src/daemon-runtime/agent-environment-activity";

const scope = { workspaceId: "ws-1", agentId: "agent-1" };

test("names every skipped variable in one warning Activity row", () => {
  const activity = ignoredAgentEnvironmentActivity(scope, {
    NODE_OPTIONS: "--require ./x.js",
    MY_VAR: "kept",
    bash_env: "/tmp/x.sh",
  });

  expect(activity?.detailKind).toBe(AGENT_ACTIVITY_DETAIL_KIND.AGENT_ENVIRONMENT_IGNORED);
  expect(activity?.level).toBe("warning");
  expect(activity?.protocolMajor).toBe(WORKSPACE_PROTOCOL_MAJOR);
  expect(activity?.workspaceId).toBe("ws-1");
  expect(activity?.agentId).toBe("agent-1");
  expect(activity?.detail).toBe(
    "Skipped NODE_OPTIONS, bash_env: CoForge never passes them to an Agent runtime.",
  );
  expect(activity?.entries?.map((entry) => (entry.kind === "text" ? entry.text : ""))).toEqual([
    "The Agent's stored environment sets NODE_OPTIONS, bash_env, which would change how the " +
      "runtime or its toolchain executes or where it looks for its own files. The Agent started " +
      "without them; remove them in the Agent's environment settings.",
  ]);
});

test("reads an ordinary variable as fine, and an absent environment as nothing to report", () => {
  expect(ignoredAgentEnvironmentActivity(scope, { MY_VAR: "kept" })).toBeUndefined();
  expect(ignoredAgentEnvironmentActivity(scope, { COFORGE_WAKE_RECYCLE: "0" })).toBeUndefined();
  expect(ignoredAgentEnvironmentActivity(scope, {})).toBeUndefined();
  expect(ignoredAgentEnvironmentActivity(scope, undefined)).toBeUndefined();
});

test("uses the singular wording for a single skipped variable", () => {
  const activity = ignoredAgentEnvironmentActivity(scope, { HOME: "/elsewhere" });

  expect(activity?.detail).toBe("Skipped HOME: CoForge never passes it to an Agent runtime.");
  expect(activity?.entries?.[0]).toMatchObject({
    text:
      "The Agent's stored environment sets HOME, which would change how the runtime or its " +
      "toolchain executes or where it looks for its own files. The Agent started without it; " +
      "remove it in the Agent's environment settings.",
  });
});
