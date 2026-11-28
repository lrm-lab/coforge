import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

export function TerminalCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-primary py-2 pe-2 ps-3 ring-1 ring-secondary ring-inset">
      <code
        dir="ltr"
        className="min-w-0 flex-1 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-secondary"
      >
        {command}
      </code>
      <ButtonUtility
        icon={copied ? Check : Copy}
        size="xs"
        color="tertiary"
        className="shrink-0"
        aria-label={m.computer_copy_terminal_command()}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
        }}
      />
    </div>
  );
}
