import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";

/** A command to paste into a terminal, dark in both themes, with its copy button. */
export function ComputerTerminalCommand({
  command,
  copyLabel,
}: {
  command: string;
  copyLabel: string;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string>();
  return (
    <div className="flex items-start gap-3 rounded-lg bg-terminal p-4 text-sm text-terminal-fg">
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{command}</code>
      <ButtonUtility
        icon={copiedCommand === command ? Check : Copy}
        size="sm"
        color="secondary"
        aria-label={copyLabel}
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopiedCommand(command);
        }}
      />
    </div>
  );
}
