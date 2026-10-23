import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

/** A command to run on the Computer itself, in a mono block with a copy control. */
export function TerminalCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-primary py-2 pr-2 pl-3 ring-1 ring-secondary ring-inset">
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-secondary">{command}</code>
      <ButtonUtility
        icon={copied ? Check : Copy}
        size="xs"
        color="tertiary"
        aria-label={m.computer_copy_terminal_command()}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
        }}
      />
    </div>
  );
}
