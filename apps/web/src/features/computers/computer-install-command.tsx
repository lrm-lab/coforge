import { useState, type ReactNode } from "react";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { connectionCommands } from "#src/features/install/install-commands";
import { m } from "#src/paraglide/messages";
import { ComputerTerminalCommand } from "./computer-terminal-command";

export function ComputerInstallCommand({
  installOrigin,
  workspaceSlug,
  status,
  className = "px-6 py-6 sm:px-8",
}: {
  installOrigin: string;
  workspaceSlug: string | null;
  /** What the caller says about the connection under the command: waiting, connected, checks. */
  status: ReactNode;
  className?: string;
}) {
  const [windows, setWindows] = useState(false);
  const commands = connectionCommands(installOrigin, workspaceSlug);
  const command = windows ? commands.windows : commands.posix;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-primary">{m.computer_connect_command()}</p>
        <ButtonGroup
          size="sm"
          aria-label={m.computer_operating_system()}
          selectedKeys={[windows ? "windows" : "posix"]}
          disallowEmptySelection
          onSelectionChange={(keys) => {
            setWindows(keys.has("windows"));
          }}
        >
          <ButtonGroupItem id="posix">{m.computer_os_macos_linux()}</ButtonGroupItem>
          <ButtonGroupItem id="windows">{m.computer_os_windows()}</ButtonGroupItem>
        </ButtonGroup>
      </div>
      <p className="text-sm text-tertiary">{m.computer_connect_instructions()}</p>
      <ComputerTerminalCommand command={command} copyLabel={m.computer_copy_command()} />
      {status}
    </div>
  );
}
