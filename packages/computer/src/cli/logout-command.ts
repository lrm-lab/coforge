import { Command } from "commander";

import { COFORGE_SERVER_URL } from "../release-channel";
import { FileCredentialStore } from "../credential-store";
import { ComputerLogout } from "../logout";

export interface LogoutCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export function createLogoutCommand(io: { stdout: (line: string) => void }): LogoutCommand {
  return {
    async run(serverUrl, options) {
      await new ComputerLogout({
        store: new FileCredentialStore(),
        writeLine: io.stdout,
      }).run({ serverUrl, json: options.json });
    },
  };
}

export function registerLogoutCommand(
  program: Command,
  logout: LogoutCommand | undefined,
  setJson: (value: boolean) => void,
) {
  program
    .command("logout")
    .description("Clear this machine's local CoForge login without removing Workspace bindings.")
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean }) => {
      const json = options.json ?? false;
      setJson(json);
      if (!logout) throw new Error("Logout is unavailable in this build");
      return logout.run(COFORGE_SERVER_URL, { json });
    });
}
