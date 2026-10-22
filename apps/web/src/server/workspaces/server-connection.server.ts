/** Host polls every 5 seconds. The light stays on through several missed heartbeats, then goes out. */
const HOST_HEARTBEAT_LEASE_MS = 90_000;

export class ServerConnectionError extends Error {
  constructor(
    readonly status: 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ServerConnectionError";
  }
}

export interface ServerConnectionPorts {
  /** When this deployment's Swarm host last registered or heartbeated. */
  hostLastSeen(): Promise<Date | undefined>;
}

export type CloudComputerServicePage = {
  connected: boolean;
  command: string;
  serviceUnit: string;
};

export class WorkspaceServerConnection {
  constructor(private readonly ports: ServerConnectionPorts) {}

  /** The page's command and system unit. Neither needs a saved row, and neither carries a secret. */
  async servicePage(origin: string, now: Date): Promise<CloudComputerServicePage> {
    const installOrigin = requireInstallOrigin(origin);
    return {
      connected: await this.#connected(now),
      command: hostConnectionCommand(installOrigin),
      serviceUnit: hostServiceUnit(installOrigin),
    };
  }

  async #connected(now: Date): Promise<boolean> {
    const lastSeen = await this.ports.hostLastSeen();
    if (!lastSeen) return false;
    const age = now.getTime() - lastSeen.getTime();
    return age >= 0 && age < HOST_HEARTBEAT_LEASE_MS;
  }
}

/** Install the binary, then start the Swarm manager process against this deployment.
 * The token, node key, cluster name, and image stay in that machine's environment. */
export function hostConnectionCommand(origin: string): string {
  return `curl -fsSL '${origin}/computer/install.sh' | sh && "$HOME/.local/bin/coforge-computer" host --server-url '${origin}'`;
}

/** A system unit. A user service stops when that login ends, so the host does not use one. */
export function hostServiceUnit(origin: string): string {
  return `[Unit]
Description=CoForge Swarm host
After=docker.service
Wants=docker.service

[Service]
User=<user>
Group=<user>
SupplementaryGroups=docker
EnvironmentFile=/home/<user>/.coforge-host/host.env
ExecStart=/home/<user>/.coforge-host/coforge-computer host --server-url ${origin}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

/** The origin pasted into `curl` must be this deployment's bare origin, with nothing a shell
 * could treat as another command. */
function requireInstallOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerConnectionError(422, "invalid install origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ServerConnectionError(422, "invalid install origin");
  }
  return value;
}
