import { useEffect, useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";

/** Copies `value`; the icon turns into a check for a moment to confirm it. */
export function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <ButtonUtility
      icon={copied ? Check : Copy}
      size="sm"
      color="tertiary"
      tooltip={copied ? m.controls_copied() : label}
      aria-label={label}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    />
  );
}
