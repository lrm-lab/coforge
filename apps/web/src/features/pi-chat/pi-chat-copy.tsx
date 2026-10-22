import { useEffect, useRef, useState } from "react";
import { Check, Copy01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";

export function PiChatCopy({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label =
    state === "copied"
      ? m.pi_chat_copied()
      : state === "failed"
        ? m.pi_chat_copy_failed()
        : m.pi_chat_copy();
  return (
    <span className="inline-flex items-center gap-2">
      <ButtonUtility
        icon={state === "copied" ? Check : Copy01}
        tooltip={label}
        aria-label={label}
        color="tertiary"
        size="xs"
        onClick={async () => {
          clearTimeout(timer.current);
          setState((await copyText(text)) ? "copied" : "failed");
          timer.current = setTimeout(() => setState("idle"), 2000);
        }}
      />
      <span role="status" className={state === "failed" ? "text-xs text-error-primary" : "sr-only"}>
        {state === "idle" ? "" : label}
      </span>
    </span>
  );
}
