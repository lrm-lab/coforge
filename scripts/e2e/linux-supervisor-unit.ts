// Prints the systemd user unit the Computer renders for its Daemon supervisor (the unit text
// SystemdUserDaemonHost renders), for this Linux account, with the paths the product resolves for
// the installed Computer. The installer's `start` registers it; a Computer without cloud setup
// (the Linux installer E2E) writes it with this helper instead. The shell caller writes the output
// to ~/.config/systemd/user/coforge-daemon.service and runs the same daemon-reload, enable and
// start the installer runs.
//
// usage: bun scripts/e2e/linux-supervisor-unit.ts
import { systemdUserUnit } from "../../packages/daemon/src/daemon-host/systemd-user";
import { resolveDaemonExecutablePath } from "../../packages/daemon/src/daemon-host/launcher";
import { resolveComputerInstallDirectory } from "../../packages/daemon/src/platform/computer-install-directory";
import {
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "../../packages/computer/src/paths";

const homeDirectory = process.env.HOME;
if (!homeDirectory) throw new Error("HOME is required");
const environment = { ...process.env };
const platform = "linux" as const;
const installRoot = resolveComputerInstallDirectory({ platform, homeDirectory });
const stateDirectory = resolveComputerStateDirectory({ platform, homeDirectory, environment });
const socketPath = resolveDaemonSocketPath({ platform, stateDirectory });
const executablePath = resolveDaemonExecutablePath({ installRoot, platform });

process.stdout.write(systemdUserUnit(executablePath, socketPath, stateDirectory));
