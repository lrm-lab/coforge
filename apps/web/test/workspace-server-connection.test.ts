import { describe, expect, test } from "bun:test";

import {
  ServerConnectionError,
  WorkspaceServerConnection,
  type ServerConnectionPorts,
  type ServerConnectionRow,
} from "#src/server/workspaces/server-connection.server";

const now = new Date("2026-10-14T07:00:00.000Z");
const origin = "http://127.0.0.1:8789";
const slug = "j123";

const hostCommand =
  "curl -fsSL 'http://127.0.0.1:8789/computer/install.sh' | sh && \"$HOME/.local/bin/coforge-computer\" host --server-url 'http://127.0.0.1:8789'";

class MemoryPorts implements ServerConnectionPorts {
  row: ServerConnectionRow | undefined;
  lastSeen: Date | undefined;

  async insert(row: ServerConnectionRow) {
    if (this.row) throw new ServerConnectionError(409, "server connection already submitted");
    this.row = { ...row };
  }

  async find(workspaceId: string) {
    return this.row?.workspaceId === workspaceId ? this.row : undefined;
  }

  async hostLastSeen() {
    return this.lastSeen;
  }
}

function connection(ports = new MemoryPorts()) {
  return { ports, service: new WorkspaceServerConnection(ports) };
}

describe("WorkspaceServerConnection", () => {
  test("saves once and returns the host command for this origin", async () => {
    const { service } = connection();

    const saved = await service.submit({
      workspaceId: "workspace-1",
      userId: "user-1",
      submittedByName: "李健",
      installOrigin: origin,
      workspaceSlug: slug,
      now,
    });

    expect(saved.command).toBe(hostCommand);
    expect(saved.connected).toBe(false);
  });

  test("a later read shows the saved values and the same host command", async () => {
    const { service } = connection();
    await service.submit({
      workspaceId: "workspace-1",
      userId: "user-1",
      submittedByName: "李健",
      installOrigin: origin,
      workspaceSlug: slug,
      now,
    });

    const view = await service.read("workspace-1", now);

    expect(view).toEqual({
      configured: true,
      installOrigin: origin,
      workspaceSlug: slug,
      submittedByUserId: "user-1",
      submittedByName: "李健",
      submittedAt: now,
      connected: false,
      command: hostCommand,
    });
  });

  test("a second save is rejected and the first row stays", async () => {
    const { ports, service } = connection();
    await service.submit({
      workspaceId: "workspace-1",
      userId: "user-1",
      submittedByName: "李健",
      installOrigin: origin,
      workspaceSlug: slug,
      now,
    });

    await expect(
      service.submit({
        workspaceId: "workspace-1",
        userId: "user-2",
        submittedByName: "其他人",
        installOrigin: "https://coforge.cn",
        workspaceSlug: slug,
        now,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(ports.row?.installOrigin).toBe(origin);
    expect(ports.row?.submittedByUserId).toBe("user-1");
  });

  test("the light is on only while the Swarm host heartbeat is fresh", async () => {
    const { ports, service } = connection();
    expect(await service.read("workspace-1", now)).toEqual({
      configured: false,
      connected: false,
    });

    await service.submit({
      workspaceId: "workspace-1",
      userId: "user-1",
      submittedByName: "李健",
      installOrigin: origin,
      workspaceSlug: slug,
      now,
    });
    expect((await service.read("workspace-1", now)).connected).toBe(false);

    ports.lastSeen = new Date(now.getTime() - 89_000);
    expect((await service.read("workspace-1", now)).connected).toBe(true);

    ports.lastSeen = new Date(now.getTime() - 90_000);
    expect((await service.read("workspace-1", now)).connected).toBe(false);
  });

  test("the service page gives the host command and system unit without saving a row", async () => {
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
    expect(ports.row).toBeUndefined();
  });

  test("rejects an origin that is not this deployment's bare origin", async () => {
    const { ports, service } = connection();

    await expect(
      service.submit({
        workspaceId: "workspace-1",
        userId: "user-1",
        submittedByName: "李健",
        installOrigin: "https://coforge.cn/computer",
        workspaceSlug: slug,
        now,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(ports.row).toBeUndefined();
  });
});
