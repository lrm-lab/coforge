import { expect, test } from "bun:test";
import { redactTrajectoryText } from "#src/agent-runtime/activity-trajectory";
import { scrubRuntimeErrorText } from "#src/agent-runtime/runtime-error-activity";
import { classifyAgentProxyFailure } from "#src/agent-proxy-failure";

/** What leaves the machine as Activity text or a log line never holds an app client secret. */
const SECRET = `cfa_secret_${"q".repeat(43)}`;

test("trajectory and runtime-error text redact an app client secret wherever it sits", () => {
  for (const text of [`the secret is ${SECRET}.`, `x=${SECRET}`, `cat file ${SECRET}\n`]) {
    expect(redactTrajectoryText(text)).not.toContain(SECRET);
    expect(scrubRuntimeErrorText(text)).not.toContain(SECRET);
  }
});

test("a proxy failure detail never echoes an app client secret", () => {
  const classified = classifyAgentProxyFailure(new Error(`upstream said ${SECRET}`), {
    method: "POST",
    path: "/x",
    routeFamily: "agent-api/app-registration",
    agentId: "agent-a",
  });
  expect(JSON.stringify(classified)).not.toContain(SECRET);
});
