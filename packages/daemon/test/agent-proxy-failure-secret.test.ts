import { expect, test } from "bun:test";
import { classifyAgentProxyFailure } from "#src/agent-proxy-failure";

const SECRET = `cfa_secret_${"q".repeat(43)}`;

test("a proxy failure detail never echoes an app client secret", () => {
  const classified = classifyAgentProxyFailure(new Error(`upstream said ${SECRET}`), {
    method: "POST",
    path: "/x",
    routeFamily: "agent-api/app-registration",
    agentId: "agent-a",
  });
  expect(JSON.stringify(classified)).not.toContain(SECRET);
});
