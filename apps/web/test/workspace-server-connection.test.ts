import { describe, expect, test } from "bun:test";

import {
  WorkspaceServerConnection,
  type ServerConnectionPorts,
} from "#src/server/workspaces/server-connection.server";

const now = new Date("2026-10-14T07:00:00.000Z");
const origin = "http://127.0.0.1:8789";

const hostCommand =
  "curl -fsSL 'http://127.0.0.1:8789/computer/install.sh' | sh && \"$HOME/.local/bin/coforge-computer\" host --server-url 'http://127.0.0.1:8789'";

class MemoryPorts implements ServerConnectionPorts {
  lastSeen: Date | undefined;

  async hostLastSeen() {
    return this.lastSeen;
  }
}

function connection(ports = new MemoryPorts()) {
  return { ports, service: new WorkspaceServerConnection(ports) };
}

describe("WorkspaceServerConnection", () => {
  test("the service page gives the host command and system unit", async () => {
    const { ports, service } = connection();
    ports.lastSeen = new Date(now.getTime() - 1_000);

    const page = await service.servicePage(origin, now);

    expect(page).toEqual({
      connected: true,
      command: hostCommand,
      serviceUnit: `[Unit]
Description=CoForge Swarm host
After=docker.service
Wants=docker.service

[Service]
User=<user>
Group=<user>
SupplementaryGroups=docker
EnvironmentFile=/home/<user>/.coforge-host/host.env
ExecStart=/home/<user>/.coforge-host/coforge-computer host --server-url http://127.0.0.1:8789
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`,
    });
  });

  test("the light is on only while the Swarm host heartbeat is fresh", async () => {
    const { ports, service } = connection();
    expect((await service.servicePage(origin, now)).connected).toBe(false);

    ports.lastSeen = new Date(now.getTime() - 89_000);
    expect((await service.servicePage(origin, now)).connected).toBe(true);

    ports.lastSeen = new Date(now.getTime() - 90_000);
    expect((await service.servicePage(origin, now)).connected).toBe(false);
  });

  test("rejects an origin that is not this deployment's bare origin", async () => {
    const { service } = connection();

    await expect(service.servicePage("https://coforge.cn/computer", now)).rejects.toMatchObject({
      status: 422,
    });
  });
});
