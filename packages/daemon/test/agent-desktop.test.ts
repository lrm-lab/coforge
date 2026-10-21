import { afterEach, expect, test } from "bun:test";

import {
  agentDesktopEnvironment,
  holdAgentDesktop,
  releaseAgentDesktop,
} from "#src/agent-runtime/agent-desktop";

const previousPort = Bun.env.COFORGE_AGENT_SCREEN_PORT;

afterEach(() => {
  if (previousPort === undefined) delete Bun.env.COFORGE_AGENT_SCREEN_PORT;
  else Bun.env.COFORGE_AGENT_SCREEN_PORT = previousPort;
});

test("a screen reply becomes that agent's display and directories", () => {
  expect(
    agentDesktopEnvironment({
      display: ":20",
      xauthority: "/screens/a/Xauthority",
      configHome: "/screens/a/config",
      dataHome: "/screens/a/data",
      cacheHome: "/screens/a/cache",
      runtimeDir: "/screens/a/runtime",
      dbus: "",
    }),
  ).toEqual({
    DISPLAY: ":20",
    XAUTHORITY: "/screens/a/Xauthority",
    XDG_CONFIG_HOME: "/screens/a/config",
    XDG_DATA_HOME: "/screens/a/data",
    XDG_CACHE_HOME: "/screens/a/cache",
    XDG_RUNTIME_DIR: "/screens/a/runtime",
  });
  expect(agentDesktopEnvironment({ display: ":20\nDISPLAY=:1" })).toEqual({});
});

test("holding a screen posts to the local control port and release drops it", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/release")) return new Response("{}\n");
      return Response.json({
        display: ":21",
        xauthority: "/screens/agent-1/Xauthority",
        configHome: "/screens/agent-1/config",
        dataHome: "/screens/agent-1/data",
        cacheHome: "/screens/agent-1/cache",
        runtimeDir: "/screens/agent-1/runtime",
        dbus: "unix:path=/screens/agent-1/bus",
      });
    },
  });
  Bun.env.COFORGE_AGENT_SCREEN_PORT = String(server.port);
  try {
    const environment = await holdAgentDesktop("agent-1");
    expect(environment.DISPLAY).toBe(":21");
    expect(environment.XDG_CONFIG_HOME).toBe("/screens/agent-1/config");
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/screens/agent-1/bus");
    await releaseAgentDesktop("agent-1");
    expect(seen).toEqual(["POST /screen/agent-1", "POST /screen/agent-1/release"]);
  } finally {
    server.stop(true);
  }
});

test("a computer with no screen service still launches", async () => {
  const refused = async () => {
    throw new Error("connection refused");
  };
  expect(await holdAgentDesktop("agent-1", refused)).toEqual({});
  await releaseAgentDesktop("not an id", refused);
});
