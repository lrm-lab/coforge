import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { StatusDot } from "#src/components/ui/status-dot";
import { connectionCommands } from "#src/features/install/install-commands";
import { m } from "#src/paraglide/messages";

export function ComputerInstallCommand({
  installOrigin,
  workspaceSlug,
  connectedComputerName,
}: {
  installOrigin: string;
  workspaceSlug: string | null;
  connectedComputerName: string | null;
}) {
  const [windows, setWindows] = useState(false);
  const [copied, setCopied] = useState(false);
  const commands = connectionCommands(installOrigin, workspaceSlug);
  const command = windows ? commands.windows : commands.posix;

  return (
    <div className="space-y-4 px-6 py-6 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-primary">{m.computer_connect_command()}</p>
        <ButtonGroup
          size="sm"
          aria-label={m.computer_operating_system()}
          selectedKeys={[windows ? "windows" : "posix"]}
          disallowEmptySelection
          onSelectionChange={(keys) => {
            setWindows(keys.has("windows"));
            setCopied(false);
          }}
        >
          <ButtonGroupItem id="posix">{m.computer_os_macos_linux()}</ButtonGroupItem>
          <ButtonGroupItem id="windows">{m.computer_os_windows()}</ButtonGroupItem>
        </ButtonGroup>
      </div>
      <p className="text-sm text-tertiary">{m.computer_connect_instructions()}</p>
      <div className="flex items-start gap-3 rounded-lg bg-terminal p-4 text-sm text-terminal-fg">
        <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{command}</code>
        <ButtonUtility
          icon={copied ? Check : Copy}
          size="sm"
          color="secondary"
          aria-label={m.computer_copy_command()}
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
          }}
        />
      </div>
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-secondary bg-secondary px-4 py-3"
      >
        <StatusDot tone={connectedComputerName ? "online" : "unknown"} className="size-2" />
        <p className="text-sm font-medium text-primary">
          {connectedComputerName
            ? m.computer_add_success_description({ name: connectedComputerName })
            : m.computer_waiting_for_connection()}
        </p>
      </div>
    </div>
  );
}
